import type { TSPPTypeExtension, TSPPTypeHost, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { GadtDeclaration, NominalDeclarations } from "./declarations";
import { findGadt } from "./gadt-types";
import type { LoweredMatch, MatchArm, MatchPattern, ValueMatches } from "./match";

interface Branch {
    readonly substitutions: Map<TS.TypeParameter, TS.Type>;
    readonly fresh: Set<TS.TypeParameter>;
    readonly fields: Map<string, TS.Type>;
    reachable: boolean;
}

interface State {
    readonly frames: WeakMap<TS.Node, Branch>;
    readonly fields: WeakMap<TS.Node, { branch: Branch; path: readonly number[]; }>;
    readonly matches: WeakMap<TS.Node, { declaration: GadtDeclaration; branches: readonly Branch[]; }>;
    readonly preparing: WeakSet<TS.Node>;
}

/** Constructor equations are local to a match arm; no assignment outside the arm acquires them. */
export function createGadtMatches(ts: TSPPTypeScript, declarations: NominalDeclarations, matches: ValueMatches): TSPPTypeExtension {
    const states = new WeakMap<TS.TypeChecker, State>();
    const hosts = new WeakMap<TS.TypeChecker, TSPPTypeHost>();
    const stateOf = (host: TSPPTypeHost): State => {
        hosts.set(host.checker, host);
        let state = states.get(host.checker);
        if (!state) states.set(host.checker, state = { frames: new WeakMap(), fields: new WeakMap(), matches: new WeakMap(), preparing: new WeakSet() });
        return state;
    };
    matches.getGadtVariants = (type, checker) => {
        const host = hosts.get(checker);
        return host && variantsFor(type, host);
    };

    function declarationOf(type: TS.Type, host: TSPPTypeHost): GadtDeclaration | undefined {
        return findGadt(type, declarations, host.checker, ts)?.declaration;
    }

    function substitute(type: TS.Type, branch: Branch, host: TSPPTypeHost): TS.Type {
        if (!branch.substitutions.size) return type;
        const mapper = host.createMapper([...branch.substitutions.keys()], [...branch.substitutions.values()]);
        // Equations can mention variables solved by a later nested pattern.
        for (let i = 0; i <= branch.substitutions.size; i++) {
            const next = host.instantiate(type, mapper);
            if (next === type) break;
            type = next;
        }
        return type;
    }

    function refine(type: TS.Type, location: TS.Node, host: TSPPTypeHost): TS.Type {
        const state = stateOf(host);
        const frames: Branch[] = [];
        for (let node: TS.Node | undefined = location; node; node = node.parent) {
            const branch = state.frames.get(node);
            if (branch && !frames.includes(branch)) frames.push(branch);
        }
        for (const branch of frames.reverse()) type = substitute(type, branch, host);
        return type;
    }

    function argumentsOf(type: TS.Type, host: TSPPTypeHost): readonly TS.Type[] {
        return type.aliasTypeArguments ?? (type.flags & ts.TypeFlags.Object && (type as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference
            ? host.checker.getTypeArguments(type as TS.TypeReference) : []);
    }

    /** A conservative equation solver: stuck type functions stay stuck, rather than being inverted. */
    function unify(left: TS.Type, right: TS.Type, branch: Branch, host: TSPPTypeHost, seen = new Set<string>()): boolean {
        left = substitute(left, branch, host);
        right = substitute(right, branch, host);
        if (left === right) return true;
        const parameter = (type: TS.Type): boolean => !!(type.flags & ts.TypeFlags.TypeParameter);
        const solve = (source: TS.TypeParameter, target: TS.Type): boolean => {
            if (contains(target, new Set([source]), host)) return true;
            const constraint = host.checker.getBaseConstraintOfType(source);
            const targetConstraint = parameter(target) ? host.checker.getBaseConstraintOfType(target) : target;
            if (constraint && targetConstraint && clearlyApart(constraint, targetConstraint, host)) return false;
            branch.substitutions.set(source, target);
            return true;
        };
        if (parameter(left) && branch.fresh.has(left as TS.TypeParameter)) return solve(left as TS.TypeParameter, right);
        if (parameter(right) && branch.fresh.has(right as TS.TypeParameter)) return solve(right as TS.TypeParameter, left);
        if (parameter(right)) return solve(right as TS.TypeParameter, left);
        if (parameter(left)) return solve(left as TS.TypeParameter, right);
        const key = `${(left as TS.Type & { id: number; }).id}:${(right as TS.Type & { id: number; }).id}`;
        if (seen.has(key)) return true;
        seen.add(key);
        const leftArgs = argumentsOf(left, host);
        const rightArgs = argumentsOf(right, host);
        // Only generative, invariant data indices and tuples with the same shape are injective. A structural alias
        // may erase its parameters (Erase<A> = {}), so equal alias names never justify equating those parameters.
        const nominal = findGadt(left, declarations, host.checker, ts);
        const rightNominal = nominal && findGadt(right, declarations, host.checker, ts);
        const sameTupleShape = host.checker.isTupleType(left) && host.checker.isTupleType(right)
            && (left as TS.TupleTypeReference).target.elementFlags.join() === (right as TS.TupleTypeReference).target.elementFlags.join();
        const generativeLeft = nominal && rightNominal?.declaration === nominal.declaration ? nominal.indices : sameTupleShape ? leftArgs : [];
        const generativeRight = nominal && rightNominal?.declaration === nominal.declaration ? rightNominal.indices : sameTupleShape ? rightArgs : [];
        if (generativeLeft.length && generativeLeft.length === generativeRight.length) {
            return generativeLeft.every((arg, index) => unify(arg, generativeRight[index], branch, host, seen));
        }
        if (left.flags & ts.TypeFlags.Object && right.flags & ts.TypeFlags.Object) {
            const lp = host.checker.getPropertiesOfType(left);
            const rp = host.checker.getPropertiesOfType(right);
            if (lp.length === rp.length && lp.length) {
                for (const property of lp) {
                    const other = host.checker.getPropertyOfType(right, ts.symbolName(property));
                    if (!other) return !clearlyApart(left, right, host);
                    if (!unify(host.checker.getTypeOfSymbol(property), host.checker.getTypeOfSymbol(other), branch, host, seen)) return false;
                }
                return true;
            }
        }
        return !clearlyApart(left, right, host);
    }

    function clearlyApart(left: TS.Type, right: TS.Type, host: TSPPTypeHost): boolean {
        if (left.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional)
            || right.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Conditional)) return false;
        // Union constraints can overlap without either being assignable to the other.
        if (left.flags & ts.TypeFlags.Union) return (left as TS.UnionType).types.every(part => clearlyApart(part, right, host));
        if (right.flags & ts.TypeFlags.Union) return (right as TS.UnionType).types.every(part => clearlyApart(left, part, host));
        if (host.checker.isTupleType(left) && host.checker.isTupleType(right)) {
            const a = (left as TS.TupleTypeReference).target;
            const b = (right as TS.TupleTypeReference).target;
            const minimum = (tuple: TS.TupleType) => tuple.elementFlags.filter(flag => flag & ts.ElementFlags.Required).length;
            const maximum = (tuple: TS.TupleType) => tuple.combinedFlags & ts.ElementFlags.Variable ? Infinity : tuple.elementFlags.length;
            if (minimum(a) > maximum(b) || minimum(b) > maximum(a)) return true;
        }
        if (left.flags & ts.TypeFlags.Object && right.flags & ts.TypeFlags.Object) {
            for (const property of host.checker.getPropertiesOfType(left)) {
                const other = host.checker.getPropertyOfType(right, ts.symbolName(property));
                if (!other) continue;
                const a = host.checker.getTypeOfSymbol(property);
                const b = host.checker.getTypeOfSymbol(other);
                if (a.flags & ts.TypeFlags.Literal && b.flags & ts.TypeFlags.Literal && clearlyApart(a, b, host)) return true;
            }
            return false;
        }
        return !host.checker.isTypeAssignableTo(left, right) && !host.checker.isTypeAssignableTo(right, left);
    }

    function contains(type: TS.Type, parameters: ReadonlySet<TS.TypeParameter>, host: TSPPTypeHost, seen = new Set<TS.Type>(), symbols = new Set<TS.Symbol>()): boolean {
        if (!parameters.size) return false;
        if (parameters.has(type as TS.TypeParameter)) return true;
        if (seen.has(type)) return false;
        seen.add(type);
        if (argumentsOf(type, host).some(arg => contains(arg, parameters, host, seen, symbols))) return true;
        if (type.flags & ts.TypeFlags.IndexedAccess) {
            const indexed = type as TS.IndexedAccessType;
            return contains(indexed.objectType, parameters, host, seen, symbols) || contains(indexed.indexType, parameters, host, seen, symbols);
        }
        if (type.flags & ts.TypeFlags.Substitution) {
            const substitution = type as TS.SubstitutionType;
            return contains(substitution.baseType, parameters, host, seen, symbols) || contains(substitution.constraint, parameters, host, seen, symbols);
        }
        if (type.flags & ts.TypeFlags.Index) return contains((type as TS.IndexType).type, parameters, host, seen, symbols);
        if (type.flags & ts.TypeFlags.TemplateLiteral) return (type as TS.TemplateLiteralType).types.some(part => contains(part, parameters, host, seen, symbols));
        if (type.flags & ts.TypeFlags.StringMapping) return contains((type as TS.StringMappingType).type, parameters, host, seen, symbols);
        if (type.flags & ts.TypeFlags.Conditional) {
            // Instantiation also sees variables in lazy true/false branches and in the conditional's mapper.
            const mapper = host.createMapper([...parameters], [...parameters].map(() => host.checker.getUnknownType()));
            return host.instantiate(type, mapper) !== type;
        }
        // A closed data constructor is an existential boundary; its erased storage is not an escaped index.
        if (declarationOf(type, host)) return false;
        // A class's constructor and instance share a symbol but have different members.
        const symbol = type.aliasSymbol ?? (host.checker.getSignaturesOfType(type, ts.SignatureKind.Construct).length ? undefined : type.symbol);
        if (symbol && symbols.has(symbol)) return false;
        if (symbol) symbols.add(symbol);
        if (type.flags & ts.TypeFlags.UnionOrIntersection) return (type as TS.UnionOrIntersectionType).types.some(part => contains(part, parameters, host, seen, symbols));
        if (!(type.flags & ts.TypeFlags.Object)) return false;
        if ((type as TS.ObjectType).objectFlags & ts.ObjectFlags.Mapped) {
            const mapper = host.createMapper([...parameters], [...parameters].map(() => host.checker.getUnknownType()));
            if (host.instantiate(type, mapper) !== type) return true;
        }
        const signatures = [...host.checker.getSignaturesOfType(type, ts.SignatureKind.Call), ...host.checker.getSignaturesOfType(type, ts.SignatureKind.Construct)];
        if (signatures.some(signature =>
            contains(host.checker.getReturnTypeOfSignature(signature), parameters, host, seen, symbols)
            || signature.parameters.some(parameter => contains(host.checker.getTypeOfSymbol(parameter), parameters, host, seen, symbols))
            || signature.typeParameters?.some(parameter => parameter.symbol?.declarations?.some(declaration =>
                ts.isTypeParameterDeclaration(declaration) && [declaration.constraint, declaration.default].some(node =>
                    node && contains(host.checker.getTypeFromTypeNode(node), parameters, host, seen, symbols)))))) return true;
        if (host.checker.getIndexInfosOfType(type).some(info => contains(info.type, parameters, host, seen, symbols))) return true;
        return host.checker.getPropertiesOfType(type).some(property => contains(host.checker.getTypeOfSymbol(property), parameters, host, seen, symbols));
    }

    function describePattern(pattern: MatchPattern, type: TS.Type, branch: Branch, host: TSPPTypeHost, path: readonly number[] = []): void {
        const declaration = declarationOf(type, host);
        const variant = declaration?.variants.find(candidate => candidate.name === pattern.variant);
        if (!variant) return;
        const signature = host.checker.getSignatureFromDeclaration(variant.declaration);
        if (!signature) return;
        const parameters = signature.typeParameters ?? [];
        const fresh: TS.TypeParameter[] = [];
        for (const parameter of parameters) {
            const constraint = host.checker.getBaseConstraintOfType(parameter);
            const mapper = host.createMapper(parameters.slice(0, fresh.length), fresh);
            const value = host.createTypeParameter(parameter.symbol, constraint && host.instantiate(constraint, mapper));
            fresh.push(value);
            branch.fresh.add(value);
        }
        const mapper = host.createMapper(parameters, fresh);
        const result = host.instantiate(host.checker.getReturnTypeOfSignature(signature), mapper);
        const actualIndexes = findGadt(type, declarations, host.checker, ts)?.indices ?? [];
        const resultIndexes = findGadt(result, declarations, host.checker, ts)?.indices ?? [];
        if (actualIndexes.length === resultIndexes.length) {
            branch.reachable &&= resultIndexes.every((index, i) => unify(index, actualIndexes[i], branch, host));
        }
        signature.parameters.forEach((parameter, index) => {
            const field = substitute(host.instantiate(host.checker.getTypeOfSymbol(parameter), mapper), branch, host);
            const fieldPath = [...path, index];
            branch.fields.set(fieldPath.join("."), field);
            const element = pattern.elements[index];
            if (element?.kind === "nested") describePattern(element.pattern, field, branch, host, fieldPath);
        });
    }

    function prepare(node: TS.Expression, match: LoweredMatch, host: TSPPTypeHost): { declaration: GadtDeclaration; branches: readonly Branch[]; } | undefined {
        const state = stateOf(host);
        const previous = state.matches.get(node);
        if (previous) return previous;
        // A direct wildcard-only match has no tag test or attached copy of its input and needs no index equations.
        if (!match.input.parent && !match.scrutinee.parent) return undefined;
        if (state.preparing.has(node)) return undefined;
        state.preparing.add(node);
        try {
            const input = host.checkExpression(match.input.parent ? match.input : match.scrutinee);
            const declaration = declarationOf(input, host);
            if (!declaration) return undefined;
            const branches = match.arms.map(arm => {
                const branch: Branch = { substitutions: new Map(), fresh: new Set(), fields: new Map(), reachable: true };
                // Or-patterns carry no bindings; only equations shared by all alternatives would be usable.
                if (arm.patterns.length === 1) describePattern(arm.patterns[0], input, branch, host);
                state.frames.set(arm.expression, branch);
                if (arm.guard) state.frames.set(arm.guard, branch);
                for (const field of arm.fields) state.fields.set(field.expression, { branch, path: field.path });
                return branch;
            });
            const result = { declaration, branches };
            state.matches.set(node, result);
            let checked = matches.gadtVariants.get(host.checker);
            if (!checked) matches.gadtVariants.set(host.checker, checked = new WeakMap());
            checked.set(match, variantsFor(input, host)!);
            return result;
        }
        finally {
            state.preparing.delete(node);
        }
    }

    function variantsFor(input: TS.Type, host: TSPPTypeHost) {
        const declaration = declarationOf(input, host);
        if (!declaration) return undefined;
        const variants = new Map<string, { fieldNames: readonly string[]; fieldTypes: readonly TS.Type[]; reachable: boolean; }>();
        for (const variant of declaration.variants) {
            const branch: Branch = { substitutions: new Map(), fresh: new Set(), fields: new Map(), reachable: true };
            describePattern({ variant: variant.name, elements: [], start: 0, end: 0 }, input, branch, host);
            variants.set(variant.name, {
                fieldNames: variant.fields.map(field => ts.idText(field.name)),
                fieldTypes: variant.fields.map((_, i) => branch.fields.get(String(i)) ?? host.checker.getUnknownType()),
                reachable: branch.reachable,
            });
        }
        return variants;
    }

    function checkArm(arm: MatchArm, branch: Branch, expected: TS.Type | undefined, host: TSPPTypeHost): TS.Type {
        if (arm.guard) host.checkExpression(arm.guard);
        const target = branch.reachable && expected ? substitute(expected, branch, host) : undefined;
        const type = host.checkExpression(arm.expression, target);
        // The binding IIFE starts in the pattern, where generated comparison errors are filtered. Report a failed
        // result check on the authored body, whose span is also useful to the editor.
        if (target) {
            const error = host.getAssignabilityError(type, target, arm.body);
            if (error) host.error(arm.body, ts.flattenDiagnosticMessageText(error.messageText, "\n"), 18093);
        }
        if (branch.reachable && !expected && contains(type, branch.fresh, host)) {
            host.error(arm.body, "A hidden constructor type escapes this match arm. Return an independent result or wrap it in a data constructor.", 18092);
        }
        return type;
    }

    return {
        resolveTypeNode: () => undefined,
        instantiateType: type => type,
        refineTypeAtLocation: (type, location, host) => refine(type, location, host),
        resolveExpressionType(node, host) {
            const state = stateOf(host);
            // TypeScript can infer an immediately invoked arrow's parameters before checking its containing call.
            // Open enclosing matches first so that this early query sees the same fresh field types.
            const ancestors: TS.Expression[] = [];
            for (let parent: TS.Node | undefined = node.parent; parent; parent = parent.parent) {
                if (matches.matches.has(parent)) ancestors.push(parent as TS.Expression);
            }
            for (const parent of ancestors.reverse()) prepare(parent, matches.matches.get(parent)!, host);
            const field = state.fields.get(node);
            if (field) {
                const type = field.branch.fields.get(field.path.join("."));
                if (type) return substitute(type, field.branch, host);
            }
            const match = matches.matches.get(node);
            if (!match) return undefined;
            const prepared = prepare(node, match, host);
            if (!prepared) return undefined;
            const expected = host.getContextualType(node);
            const results = match.arms.map((arm, i) => checkArm(arm, prepared.branches[i], expected, host));
            return expected ?? host.getUnionType(results.filter((_, i) => prepared.branches[i].reachable));
        },
    };
}
