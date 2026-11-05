import type { TSPPTypeOperations, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { superclassField } from "./syntax";
import type { TypeclassSyntax } from "./syntax";

export type Evidence =
    /** An `impl` in scope, by the name that declares it in this file. */
    | { readonly kind: "impl"; readonly name: TS.Identifier; }
    /** The dictionary an enclosing function receives for its typeclass item number `index`. */
    | { readonly kind: "parameter"; readonly fn: TS.SignatureDeclaration; readonly index: number; }
    /** The dictionary an enclosing class keeps for its typeclass item number `index`. */
    | { readonly kind: "member"; readonly cls: TS.ClassLikeDeclaration; readonly index: number; }
    /** A property of the `@` argument of the call. */
    | { readonly kind: "context"; readonly property: string; }
    /** A generic implementation applied to the dictionaries its `where` clause asks for. */
    | { readonly kind: "constructed"; readonly constructor: Evidence; readonly dictionaries: readonly Evidence[]; }
    /** The superclass dictionary another dictionary holds. */
    | { readonly kind: "superclass"; readonly of: Evidence; readonly name: string; };

export type SearchResult = { readonly evidence: Evidence; readonly failure?: undefined; } | { readonly evidence?: undefined; readonly failure: string; };

/** Finds dictionaries: what matches a goal, in which layer, and how a generic implementation gets what it needs. */
export function createSearch(ts: TSPPTypeScript, syntax: TypeclassSyntax, checker: TS.TypeChecker, types: TSPPTypeOperations, retain: (symbol: TS.Symbol) => void) {
    const show = (type: TS.Type) => checker.typeToString(type);
    const isAny = (type: TS.Type) => !!(type.flags & ts.TypeFlags.Any);
    const resolveAlias = (symbol: TS.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const isTypeclassSymbol = (symbol: TS.Symbol | undefined) => !!symbol?.declarations?.some(declaration => syntax.typeclasses.has(declaration));
    const isTypeclassType = (type: TS.Type) => isTypeclassSymbol(type.aliasSymbol ? undefined : type.symbol);
    const typeOf = (item: TS.TypeNode) => checker.getTypeFromTypeNode(item);

    const typeclassItems = (declaration: TS.Node) => (syntax.wheres.get(declaration)?.items ?? []).filter(item => isTypeclassType(typeOf(item)));

    const typeArgumentsOf = (type: TS.Type): readonly TS.Type[] => {
        if (!(type.flags & ts.TypeFlags.Object) || !((type as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return [];
        const reference = type as TS.TypeReference;
        return checker.getTypeArguments(reference).slice(0, reference.target.typeParameters?.length ?? 0);
    };

    const sameType = (a: TS.Type, b: TS.Type) => !isAny(a) && !isAny(b) && (a === b || checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a));

    /** Typeclasses are nominal, their type arguments match by identity, and `any` takes no part in the search. */
    const satisfies = (goal: TS.Type, candidate: TS.Type) => {
        if (goal.symbol !== candidate.symbol) return false;
        const goalArguments = typeArgumentsOf(goal);
        const candidateArguments = typeArgumentsOf(candidate);
        return goalArguments.length === candidateArguments.length && goalArguments.every((argument, index) => sameType(argument, candidateArguments[index]));
    };

    const isAnonymousObject = (type: TS.Type) => !!(type.flags & ts.TypeFlags.Object) && !!((type as TS.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) && !checker.getSignaturesOfType(type, ts.SignatureKind.Call).length;

    /** Matches `pattern` against `actual`, binding `parameters` in it. There is no general inference to reuse here. */
    const unify = (pattern: TS.Type, actual: TS.Type, parameters: readonly TS.Type[], bound: Map<TS.Type, TS.Type>): boolean => {
        if (parameters.includes(pattern)) {
            if (isAny(actual)) return false;
            const known = bound.get(pattern);
            if (known) return sameType(known, actual);
            bound.set(pattern, actual);
            return true;
        }
        if (pattern.aliasSymbol && pattern.aliasSymbol === actual.aliasSymbol) {
            const patternArguments = pattern.aliasTypeArguments ?? [];
            const actualArguments = actual.aliasTypeArguments ?? [];
            return patternArguments.length === actualArguments.length && patternArguments.every((argument, index) => unify(argument, actualArguments[index], parameters, bound));
        }
        const patternArguments = typeArgumentsOf(pattern);
        if (patternArguments.length && (pattern as TS.TypeReference).target === (actual as TS.TypeReference).target) {
            const actualArguments = typeArgumentsOf(actual);
            return patternArguments.every((argument, index) => unify(argument, actualArguments[index], parameters, bound));
        }
        if (isAnonymousObject(pattern) && isAnonymousObject(actual)) {
            const patternProperties = checker.getPropertiesOfType(pattern);
            const actualProperties = checker.getPropertiesOfType(actual);
            return patternProperties.length === actualProperties.length && patternProperties.every(property => {
                const other = actualProperties.find(candidate => candidate.escapedName === property.escapedName);
                return !!other && !!property.declarations?.length && unify(checker.getTypeOfSymbol(property), checker.getTypeOfSymbol(other), parameters, bound);
            });
        }
        return sameType(pattern, actual);
    };

    const mapperOf = (parameters: readonly TS.TypeParameter[], bound: ReadonlyMap<TS.Type, TS.Type>) =>
        types.createMapper(parameters, parameters.map(parameter => bound.get(parameter)!));

    const parametersOf = (declaration: TS.SignatureDeclaration) => checker.getSignatureFromDeclaration(declaration)?.typeParameters ?? [];

    /** The superclasses a typeclass type requires, as types of its own arguments. */
    const superclassesOf = (type: TS.Type): readonly { readonly type: TS.Type; readonly field: string; }[] => {
        const declaration = type.symbol?.declarations?.find(candidate => syntax.typeclasses.has(candidate));
        if (!declaration) return [];
        const declared = checker.getDeclaredTypeOfSymbol(type.symbol) as TS.InterfaceType;
        const parameters = declared.typeParameters ?? [];
        const mapper = parameters.length ? types.createMapper(parameters, typeArgumentsOf(type) as TS.Type[]) : undefined;
        return typeclassItems(declaration).map(item => ({ type: mapper ? types.instantiate(typeOf(item), mapper) : typeOf(item), field: superclassField(ts, item) ?? "" }));
    };

    /** Every dictionary `evidence` reaches through superclasses, itself first. */
    const withSuperclasses = (type: TS.Type, evidence: Evidence): readonly { readonly type: TS.Type; readonly evidence: Evidence; }[] => [
        { type, evidence },
        ...superclassesOf(type).flatMap(parent => withSuperclasses(parent.type, { kind: "superclass", of: evidence, name: parent.field })),
    ];

    /** The declarations around `node` whose `where` clauses it can use, nearest first. */
    function* enclosingConstrained(node: TS.Node): Generator<TS.Node> {
        let last = node;
        for (let current = node.parent; current; last = current, current = current.parent) {
            if (!syntax.wheres.has(current)) continue;
            // Static members of a class do not belong to an instance, whose dictionaries they would need.
            if (ts.isClassLike(current) && ts.canHaveModifiers(last) && ts.getModifiers(last)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword)) continue;
            if (ts.isClassLike(current) && ts.isClassStaticBlockDeclaration(last)) continue;
            yield current;
        }
    }

    /** A predicate holds when it reduces to `true`, or when an enclosing `where` already requires this very type. */
    const predicateHolds = (type: TS.Type, node: TS.Node) => {
        if (type.flags & ts.TypeFlags.BooleanLiteral && checker.typeToString(type) === "true") return true;
        for (const scope of enclosingConstrained(node)) {
            if (syntax.wheres.get(scope)!.items.some(item => typeOf(item) === type)) return true;
        }
        return false;
    };

    const scopeEvidence = (declaration: TS.Node, index: number): Evidence =>
        ts.isClassLike(declaration) ? { kind: "member", cls: declaration, index } : { kind: "parameter", fn: declaration as TS.SignatureDeclaration, index };

    /** An implementation's type as a pattern: its own type parameters, when it is a generic one. */
    const applyConstructor = (goal: TS.Type, factory: TS.FunctionDeclaration, reference: Evidence, at: TS.Node, context: TS.Expression | undefined, stack: readonly TS.Type[], name: string): SearchResult | undefined => {
        const parameters = parametersOf(factory);
        const bound = new Map<TS.Type, TS.Type>();
        if (!unify(typeOf(factory.type!), goal, parameters, bound)) return undefined;
        if (parameters.some(parameter => !bound.has(parameter))) return undefined;
        const mapper = parameters.length ? mapperOf(parameters, bound) : undefined;
        const dictionaries: Evidence[] = [];
        for (const item of syntax.wheres.get(factory)?.items ?? []) {
            const required = mapper ? types.instantiate(typeOf(item), mapper) : typeOf(item);
            if (!isTypeclassType(typeOf(item))) {
                if (!predicateHolds(required, at)) return { failure: `using ${name} requires '${show(required)}', which does not hold` };
                continue;
            }
            const found = search(required, at, context, [...stack, goal]);
            if (found.failure) return { failure: `using ${name} requires '${show(required)}': ${found.failure}` };
            dictionaries.push(found.evidence!);
        }
        return { evidence: { kind: "constructed", constructor: reference, dictionaries } };
    };

    const ambiguous = (goal: TS.Type, names: readonly string[]): SearchResult => ({
        failure: `'${show(goal)}' has several implementations: ${names.join(", ")}. Choose one with '@'`,
    });

    /** The first layer that has an answer wins; within a layer, more than one is an error. */
    const search = (goal: TS.Type, at: TS.Node, context: TS.Expression | undefined, stack: readonly TS.Type[]): SearchResult => {
        if (stack.includes(goal)) return { failure: `the search returns to itself: ${[...stack, goal].map(show).join(" -> ")}` };
        if (stack.length > 16) return { failure: `the search goes too deep: ${[...stack, goal].map(show).join(" -> ")}` };
        if (context) {
            const matches: { readonly name: string; readonly found: SearchResult; }[] = [];
            for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(context))) {
                const name = ts.symbolName(property);
                const type = checker.getTypeOfSymbolAtLocation(property, context);
                const factory = type.symbol?.valueDeclaration;
                if (factory && ts.isFunctionDeclaration(factory) && syntax.impls.has(factory)) {
                    const found = applyConstructor(goal, factory, { kind: "context", property: name }, at, context, stack, name);
                    if (found) matches.push({ name, found });
                }
                else if (satisfies(goal, type)) matches.push({ name, found: { evidence: { kind: "context", property: name } } });
            }
            if (matches.length > 1) return ambiguous(goal, matches.map(match => match.name));
            if (matches.length) return matches[0].found;
        }
        for (const scope of enclosingConstrained(at)) {
            const matches = typeclassItems(scope).flatMap((item, index) => withSuperclasses(typeOf(item), scopeEvidence(scope, index)).filter(entry => satisfies(goal, entry.type)).map(entry => ({ item, evidence: entry.evidence })));
            if (matches.length > 1) return ambiguous(goal, matches.map(match => syntax.wheres.get(scope)!.itemTexts.get(match.item) ?? "?"));
            if (matches.length) return { evidence: matches[0].evidence };
        }
        const found = new Map<TS.Node, { readonly symbol: TS.Symbol; readonly factory?: TS.FunctionDeclaration; }>();
        for (const symbol of checker.getSymbolsInScope(at, ts.SymbolFlags.Value | ts.SymbolFlags.Alias)) {
            // An exported declaration appears in scope as a local symbol that points at the exported one.
            const target = resolveAlias(checker.getExportSymbolOfSymbol(symbol));
            const declaration = target.valueDeclaration;
            if (!declaration || !syntax.impls.has(declaration) || found.has(declaration)) continue;
            if (ts.isFunctionDeclaration(declaration)) {
                const bound = new Map<TS.Type, TS.Type>();
                if (unify(typeOf(declaration.type!), goal, parametersOf(declaration), bound)) found.set(declaration, { symbol, factory: declaration });
            }
            else if (satisfies(goal, checker.getTypeOfSymbolAtLocation(target, at))) found.set(declaration, { symbol });
        }
        if (found.size > 1) return ambiguous(goal, [...found.values()].map(({ symbol }) => ts.symbolName(symbol)));
        const [only] = found.values();
        if (!only) return { failure: "no implementation is available in this scope" };
        if (only.symbol.flags & ts.SymbolFlags.Alias) retain(only.symbol);
        const name = (only.symbol.declarations![0] as TS.NamedDeclaration).name as TS.Identifier;
        const reference: Evidence = { kind: "impl", name };
        return only.factory
            ? applyConstructor(goal, only.factory, reference, at, context, stack, ts.symbolName(only.symbol)) ?? { failure: "no implementation is available in this scope" }
            : { evidence: reference };
    };

    return { search, unify, satisfies, predicateHolds, typeclassItems, isTypeclassSymbol, isTypeclassType, resolveAlias, typeOf, superclassesOf, typeArgumentsOf, parametersOf, show };
}
