import type { TSPPDiagnosticProvider, TSPPSignatureConstraint, TSPPTypeOperations, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { createSignatureConstraint } from "./constraint";
import { createInherentLookup, isUnusedInherentDiagnostic } from "./inherent";
import { createSearch } from "./search";
import type { Evidence } from "./search";
import type { InherentBlock, TypeclassSyntax } from "./syntax";

export type { Evidence } from "./search";

const codes = {
    noEvidence: 19101,
    ambiguous: 19102,
    predicate: 19103,
    context: 19104,
    declaration: 19105,
    value: 19106,
    relation: 19107,
    inherent: 19108,
    isolated: 19109,
    inferred: 19110,
};

export interface CallResolution {
    /** The dictionaries to pass, in the order of the callee's typeclass items; for `Eq.equals(...)`, the one to call on. */
    readonly evidence: readonly Evidence[];
    readonly method: boolean;
    /** For an inherent method, the function to call and whether the receiver is its first argument. */
    readonly helper?: TS.FunctionDeclaration;
    readonly receiverFirst?: boolean;
    /** The `@` argument as lowered, and the expression after the `@`. */
    readonly contextArgument?: TS.Node;
    readonly context?: TS.Expression;
}

/** What emit adds to a class: the dictionaries its base constructor needs when the class has no constructor of its own. */
export interface ClassResolution {
    readonly baseEvidence: readonly Evidence[];
}

export interface FileResolutions {
    readonly calls: Map<TS.Node, CallResolution>;
    readonly classes: Map<TS.Node, ClassResolution>;
    /** The dictionaries an implementation's object holds for its typeclass's superclasses. */
    readonly superclasses: Map<TS.Node, readonly { readonly name: string; readonly evidence: Evidence; }[]>;
}

export interface TypeclassEvidence {
    readonly provider: TSPPDiagnosticProvider;
    readonly constraint: TSPPSignatureConstraint;
    /** What the provider found for `sourceFile`, once it has run with `checker`. */
    resolutions(checker: TS.TypeChecker, sourceFile: TS.SourceFile): FileResolutions | undefined;
    /** Whether a diagnostic reports an import as unused that generated code or restored declarations use. */
    isUsedImportDiagnostic(diagnostic: TS.Diagnostic): boolean;
    /** The typeclass items of a `where` clause, by the position they hold among its items. */
    typeclassItems(declaration: TS.Node, checker: TS.TypeChecker): readonly TS.TypeNode[];
    /** A diagnostic about a generated superclass field, which the checker cannot name, as an author can read it. */
    rewordFieldDiagnostic(diagnostic: TS.Diagnostic): TS.Diagnostic | undefined;
    /** The options of the program being checked, which decide what can be reported as impossible. */
    useOptions(options: TS.CompilerOptions): void;
}

const isTypeclassItemOf = (syntax: TypeclassSyntax, checker: TS.TypeChecker, item: TS.TypeNode) =>
    !!checker.getTypeFromTypeNode(item).symbol?.declarations?.some(declaration => syntax.typeclasses.has(declaration));

/** Resolves `where` constraints and finds the dictionary for every call that needs one. */
export function createTypeclassEvidence(ts: TSPPTypeScript, syntax: TypeclassSyntax): TypeclassEvidence {
    const results = new WeakMap<TS.TypeChecker, WeakMap<TS.SourceFile, FileResolutions>>();
    const usedImports = new Set<string>();
    const inherentLookup = createInherentLookup(ts, syntax);

    const typeclassItems = (declaration: TS.Node, checker: TS.TypeChecker) => (syntax.wheres.get(declaration)?.items ?? []).filter(item => isTypeclassItemOf(syntax, checker, item));

    const noRetain = () => {};
    let options: TS.CompilerOptions = {};

    const constraint = createSignatureConstraint(ts, syntax, inherentLookup, typeclassItems, isTypeclassItemOf, () => {});

    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true);
    // Nodes have no `getStart` and `getText` outside editor services, and the command line runs without those.
    const startOf = (node: TS.Node, sourceFile: TS.SourceFile) => {
        scanner.setText(sourceFile.text, node.pos);
        scanner.scan();
        // Missing syntax is empty, and the next token is past it.
        return Math.min(scanner.getTokenStart(), node.end);
    };
    const keyOf = (node: TS.Node, sourceFile: TS.SourceFile) => `${sourceFile.fileName}:${startOf(node, sourceFile)}`;

    const provider: TSPPDiagnosticProvider = {
        id: "typeclasses",
        getSemanticDiagnostics(sourceFile, checker, types) {
            const diagnostics: TS.Diagnostic[] = [];
            if (!syntax.used() || sourceFile.isDeclarationFile) return diagnostics;
            const resolutions: FileResolutions = { calls: new Map(), classes: new Map(), superclasses: new Map() };
            analyze(sourceFile, checker, types, diagnostics, resolutions);
            if (options.isolatedModules) {
                for (const [call, resolution] of resolutions.calls) {
                    if (resolution.evidence.length || resolution.helper) {
                        const start = startOf(call, sourceFile);
                        diagnostics.push({ file: sourceFile, start, length: call.end - start, messageText: "This call needs dictionaries or functions the checker finds across files, which 'isolatedModules' rules out: a tool that transpiles one file at a time cannot pass them.", category: ts.DiagnosticCategory.Error, code: codes.isolated, source: "typeclasses" });
                    }
                }
            }
            let forChecker = results.get(checker);
            if (!forChecker) results.set(checker, forChecker = new WeakMap());
            forChecker.set(sourceFile, resolutions);
            return diagnostics;
        },
        filterDiagnostic(diagnostic) {
            // `(context, [] as const)`: the left side of the comma exists to be checked.
            if (diagnostic.code === 2695) return false;
            if (isUnusedInherentDiagnostic(ts, syntax, diagnostic)) return false;
            // An implementation's superclass fields are filled in by emit, unlike those of a dictionary an author writes.
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
            if (diagnostic.code === 2741 && message.startsWith("Property '(Missing)'")) return false;
            const missing = /is missing the following properties from type '.*': (.*)$/m.exec(message)?.[1];
            return !(diagnostic.code === 2739 && missing && missing.split(", ").every(name => name === "(Missing)"));
        },
    };

    function analyze(sourceFile: TS.SourceFile, checker: TS.TypeChecker, types: TSPPTypeOperations, diagnostics: TS.Diagnostic[], resolutions: FileResolutions) {
        const report = (node: TS.Node, code: number, message: string) => {
            const start = startOf(node, sourceFile);
            diagnostics.push({ file: sourceFile, start, length: node.end - start, messageText: message, category: ts.DiagnosticCategory.Error, code, source: "typeclasses" });
        };

        const keepImport = (symbol: TS.Symbol) => {
            for (const declaration of symbol.declarations ?? []) {
                usedImports.add(keyOf(declaration, sourceFile));
                let statement: TS.Node = declaration;
                while (statement.parent && !ts.isImportDeclaration(statement)) statement = statement.parent;
                usedImports.add(keyOf(statement, sourceFile));
            }
        };
        const retain = (symbol: TS.Symbol) => {
            types.markAliasReferenced(symbol);
            keepImport(symbol);
        };
        const tools = createSearch(ts, syntax, checker, types, retain);
        const typeOnly = createSearch(ts, syntax, checker, types, noRetain);
        const { typeOf, show, isTypeclassSymbol, isTypeclassType, resolveAlias, predicateHolds, parametersOf, typeArgumentsOf, unify } = tools;

        const findEvidence = (goal: TS.Type, at: TS.Node, context: TS.Expression | undefined, search = tools.search): Evidence | undefined => {
            const found = search(goal, at, context, []);
            if (found.evidence) return found.evidence;
            const ambiguous = /has several implementations/.test(found.failure!);
            report(at, ambiguous ? codes.ambiguous : codes.noEvidence, ambiguous ? `The constraint ${found.failure}.` : `Cannot satisfy the constraint '${show(goal)}': ${found.failure}.`);
            return undefined;
        };

        const keepItemNames = (item: TS.TypeNode) => {
            const keepNames = (node: TS.Node): void => {
                if (ts.isTypeReferenceNode(node)) {
                    let name: TS.EntityName = node.typeName;
                    while (ts.isQualifiedName(name)) name = name.left;
                    const symbol = checker.getSymbolAtLocation(name);
                    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
                        types.markAliasVisibleInDeclarations(symbol);
                        keepImport(symbol);
                    }
                    // A type only a clause names is written beside it in declaration output, as one a signature names is.
                    else if (symbol?.declarations?.some(declaration => declaration.parent === sourceFile)) types.markAliasVisibleInDeclarations(symbol);
                }
                ts.forEachChild(node, keepNames);
            };
            keepNames(item);
        };

        const checkClause = (declaration: TS.Node) => {
            const clause = syntax.wheres.get(declaration);
            for (const item of clause?.items ?? []) {
                const type = typeOf(item);
                if (type.flags & ts.TypeFlags.Any && (type as { intrinsicName?: string; }).intrinsicName === "error") {
                    report(item.pos >= 0 && item.end > 0 ? item : declaration, codes.declaration, `Cannot resolve the constraint '${clause!.itemTexts.get(item)}'.`);
                }
                keepItemNames(item);
            }
        };

        const checkOverloads = (fn: TS.FunctionDeclaration) => {
            // All overloads and the implementation receive the same dictionaries, so they must ask for the same ones.
            const symbol = fn.name && checker.getSymbolAtLocation(fn.name);
            const declarations = symbol?.declarations?.filter(ts.isFunctionDeclaration) ?? [];
            if (declarations.length < 2 || declarations[0] !== fn) return;
            const sequence = (declaration: TS.FunctionDeclaration) => typeclassItems(declaration, checker).map(item => typeOf(item).symbol);
            const first = sequence(fn);
            for (const other of declarations.slice(1)) {
                const items = sequence(other);
                if (items.length !== first.length || items.some((item, index) => item !== first[index])) {
                    report(other.name ?? other, codes.declaration, "All overloads of a function and its implementation must require the same typeclasses in the same order.");
                }
            }
        };

        const mentionsParameter = (node: TS.Node, parameter: TS.Type): boolean =>
            (ts.isTypeReferenceNode(node) && checker.getTypeFromTypeNode(node) === parameter) || !!ts.forEachChild(node, child => mentionsParameter(child, parameter));

        const checkImpl = (declaration: TS.VariableDeclaration | TS.FunctionDeclaration) => {
            const type = declaration.type && typeOf(declaration.type);
            if (!type || !isTypeclassType(type)) {
                report(declaration.type ?? declaration, codes.declaration, "An implementation must name a typeclass.");
                return;
            }
            let top: TS.Node = declaration.parent;
            if (ts.isVariableDeclaration(declaration)) top = declaration.parent.parent.parent;
            if (!ts.isSourceFile(top)) report(declaration.name ?? declaration, codes.declaration, "An implementation must be declared at the top level of a module.");
            // Every type parameter has to come from the typeclass applied, or nothing could say what it is.
            if (ts.isFunctionDeclaration(declaration) && parametersOf(declaration).some(parameter => !mentionsParameter(declaration.type!, parameter))) {
                report(declaration.name ?? declaration, codes.declaration, "Every type parameter of an implementation must appear in the typeclass it implements.");
            }
            const body = syntax.implBodies.get(declaration);
            const parents = tools.superclassesOf(type);
            if (!body || !parents.length) return;
            const held: { name: string; evidence: Evidence; }[] = [];
            for (const parent of parents) {
                const found = findEvidence(parent.type, body, undefined);
                if (found) held.push({ name: parent.field, evidence: found });
            }
            resolutions.superclasses.set(body, held);
        };

        const checkContext = (context: TS.Expression) => {
            for (const property of checker.getPropertiesOfType(checker.getTypeAtLocation(context))) {
                const type = checker.getTypeOfSymbolAtLocation(property, context);
                const factory = type.symbol?.valueDeclaration;
                if (!isTypeclassType(type) && !(factory && syntax.impls.has(factory))) {
                    report(context, codes.context, `'${ts.symbolName(property)}' in this '@' context is not an implementation.`);
                }
            }
        };

        const contextOf = (call: TS.CallExpression | TS.NewExpression) => {
            const contextArguments = (call.arguments ?? []).filter(argument => syntax.contexts.has(argument));
            for (const argument of contextArguments) {
                if (argument !== call.arguments![0]) report(syntax.contexts.get(argument)!, codes.context, "An '@' context must be the first argument of a call.");
            }
            const contextArgument = contextArguments[0];
            const context = contextArgument && syntax.contexts.get(contextArgument);
            if (context) checkContext(context);
            return { contextArgument, context };
        };

        /** The dictionaries `clause` asks for, with its type parameters bound by `mapper`; undefined when one is missing. */
        const resolveClause = (declaration: TS.Node, mapper: ReturnType<TSPPTypeOperations["createMapper"]> | undefined, at: TS.Node, context: TS.Expression | undefined, search = tools.search): readonly Evidence[] | undefined => {
            const clause = syntax.wheres.get(declaration);
            const evidence: Evidence[] = [];
            let complete = true;
            for (const item of clause?.items ?? []) {
                const declared = typeOf(item);
                const type = mapper ? types.instantiate(declared, mapper) : declared;
                if (isTypeclassType(declared)) {
                    const found = findEvidence(type, at, context, search);
                    if (found) evidence.push(found);
                    else complete = false;
                }
                else if (!predicateHolds(type, at)) {
                    complete = false;
                    const text = clause!.itemTexts.get(item);
                    const reason = type.flags & ts.TypeFlags.BooleanLiteral
                        ? `Constraint '${text}' is false for this use.`
                        : `Constraint '${text}' does not reduce to 'true' for this use: it is '${show(type)}'.`;
                    const overloads = (declaration as TS.Node & { symbol?: TS.Symbol; }).symbol?.declarations?.filter(other => syntax.wheres.has(other)).length ?? 0;
                    report(at, codes.predicate, overloads > 1 ? `No overload's constraints hold. First overload: ${reason}` : reason);
                }
            }
            return complete ? evidence : undefined;
        };

        /** The type arguments `receiver` gives the class or interface that declares a member, through its base types. */
        const typeArgumentsFor = (receiver: TS.Type, owner: TS.Symbol): readonly TS.Type[] | undefined => {
            if (receiver.symbol === owner) return typeArgumentsOf(receiver);
            if (!(receiver.flags & ts.TypeFlags.Object) || !((receiver as TS.ObjectType).objectFlags & (ts.ObjectFlags.ClassOrInterface | ts.ObjectFlags.Reference))) return undefined;
            const target = ((receiver as TS.TypeReference).target ?? receiver) as TS.InterfaceType;
            const parameters = target.typeParameters ?? [];
            const mapper = parameters.length ? types.createMapper(parameters, typeArgumentsOf(receiver) as TS.Type[]) : undefined;
            for (const base of checker.getBaseTypes(target)) {
                const found = typeArgumentsFor(mapper ? types.instantiate(base, mapper) : base, owner);
                if (found) return found;
            }
            return undefined;
        };

        const signatureMapper = (call: TS.CallExpression, signature: TS.Signature, declaration: TS.SignatureDeclaration) => {
            const sources: TS.TypeParameter[] = [];
            const targets: TS.Type[] = [];
            const own = parametersOf(declaration);
            const typeArguments = checker.getTypeArgumentsForResolvedSignature(signature);
            if (own.length) {
                if ((typeArguments?.length ?? 0) < own.length) return { broken: true };
                sources.push(...own);
                targets.push(...typeArguments!.slice(0, own.length).map(argument => inferred(call, argument)));
            }
            const owner = declaration.parent;
            const callee = call.expression;
            if ((ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) && ts.isPropertyAccessExpression(callee)) {
                const symbol = (owner as { symbol?: TS.Symbol; }).symbol;
                const parameters = symbol && (checker.getDeclaredTypeOfSymbol(symbol) as TS.InterfaceType).typeParameters;
                const receiverArguments = parameters && typeArgumentsFor(checker.getTypeAtLocation(callee.expression), symbol!);
                if (parameters && receiverArguments && receiverArguments.length >= parameters.length) {
                    sources.push(...parameters);
                    targets.push(...receiverArguments.slice(0, parameters.length));
                }
            }
            return { mapper: sources.length ? types.createMapper(sources, targets) : undefined };
        };

        /** An inferred literal, as in `show(1)`, asks for the type's implementation; a written `show<1>(1)` means the literal. */
        const inferred = (call: TS.CallExpression, type: TS.Type) => call.typeArguments ? type : checker.getBaseTypeOfLiteralType(type);

        const analyzeMethodOfTypeclass = (call: TS.CallExpression, typeclass: TS.Symbol, context: TS.Expression | undefined, contextArgument: TS.Node | undefined, typeArguments: readonly TS.Type[] | undefined) => {
            const declared = checker.getDeclaredTypeOfSymbol(typeclass) as TS.InterfaceType;
            const parameters = declared.typeParameters ?? [];
            // While a file is being edited, a broken call may have no type arguments to read.
            if ((typeArguments?.length ?? 0) < parameters.length) return;
            // A method's own type parameters come before the typeclass's.
            const goal = parameters.length ? types.instantiate(declared, types.createMapper(parameters, typeArguments!.slice(-parameters.length).map(argument => inferred(call, argument)))) : declared;
            const evidence = findEvidence(goal, call, context);
            if (evidence) resolutions.calls.set(call, { evidence: [evidence], method: true, contextArgument, context });
        };

        /** `option.isSome()`: the receiver, then a function of the module that declares the type. */
        const analyzeInherentCall = (call: TS.CallExpression, member: TS.Symbol, context: TS.Expression | undefined, contextArgument: TS.Node | undefined): boolean => {
            const signature = member.declarations?.find(ts.isMethodSignature);
            const companion = signature?.parent;
            const block = companion && syntax.inherent.get(companion);
            if (!signature || !block || !ts.isPropertyAccessExpression(call.expression)) return false;
            const receiver = checker.getTypeAtLocation(call.expression.expression);
            const parameters = (checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation((companion as TS.InterfaceDeclaration).name)!) as TS.InterfaceType).typeParameters ?? [];
            const bound = new Map<TS.Type, TS.Type>();
            const head = typeOf(block.head);
            if (!unify(head, receiver, parameters, bound)) unify(head, checker.getApparentType(receiver), parameters, bound);
            const resolved = checker.getResolvedSignature(call);
            const own = parametersOf(signature);
            const typeArguments = resolved && checker.getTypeArgumentsForResolvedSignature(resolved);
            const sources = [...parameters, ...own];
            const targets = [...parameters.map(parameter => bound.get(parameter)!), ...(typeArguments ?? []).slice(0, own.length)];
            if (targets.length < sources.length || targets.some(target => !target)) return true;
            const mapper = sources.length ? types.createMapper(sources, targets) : undefined;
            const evidence = resolveClause(signature, mapper, call, context);
            const helper = block.helpers.get(ts.idText(call.expression.name as TS.Identifier));
            if (evidence && helper) resolutions.calls.set(call, { evidence, method: false, helper, receiverFirst: true, contextArgument, context });
            return true;
        };

        const analyzeCall = (call: TS.CallExpression) => {
            const { contextArgument, context } = contextOf(call);
            const callee = call.expression;
            if (callee.kind === ts.SyntaxKind.SuperKeyword) {
                analyzeSuperCall(call, context, contextArgument);
                return;
            }
            const signature = checker.getResolvedSignature(call);
            if (ts.isPropertyAccessExpression(callee)) {
                const owner = ts.isIdentifier(callee.expression) ? checker.getSymbolAtLocation(callee.expression) : undefined;
                const typeclass = owner && resolveAlias(owner);
                if (isTypeclassSymbol(typeclass)) {
                    analyzeMethodOfTypeclass(call, typeclass!, context, contextArgument, signature && checker.getTypeArgumentsForResolvedSignature(signature));
                    return;
                }
                const member = checker.getSymbolAtLocation(callee.name);
                if (member && analyzeInherentCall(call, member, context, contextArgument)) return;
            }
            const declaration = signature?.declaration;
            const helper = declaration && syntax.helpers.has(declaration) ? declaration as TS.FunctionDeclaration : undefined;
            if (!declaration || !syntax.wheres.get(declaration)) {
                if (context) report(context, codes.context, "This call does not take an '@' context: the function has no 'where' clause.");
                if (helper) resolutions.calls.set(call, { evidence: [], method: false, helper });
                return;
            }
            const { mapper, broken } = signatureMapper(call, signature!, declaration as TS.SignatureDeclaration);
            if (broken) return;
            const evidence = resolveClause(declaration, mapper, call, context);
            if (evidence) resolutions.calls.set(call, { evidence, method: false, helper, contextArgument, context });
        };

        const classOfType = (type: TS.Type) => type.symbol?.declarations?.find(ts.isClassLike);

        const classMapper = (cls: TS.ClassLikeDeclaration, instance: TS.Type) => {
            const parameters = (checker.getDeclaredTypeOfSymbol((cls as { symbol?: TS.Symbol; }).symbol!) as TS.InterfaceType).typeParameters ?? [];
            const typeArguments = typeArgumentsOf(instance);
            if (typeArguments.length < parameters.length) return { broken: parameters.length > 0 };
            return { mapper: parameters.length ? types.createMapper(parameters, typeArguments.slice(0, parameters.length)) : undefined };
        };

        const analyzeNew = (node: TS.NewExpression) => {
            const { contextArgument, context } = contextOf(node);
            const signature = checker.getResolvedSignature(node);
            const instance = signature && checker.getReturnTypeOfSignature(signature);
            const cls = instance && classOfType(instance);
            if (!cls || !syntax.wheres.has(cls)) {
                if (context) report(context, codes.context, "This call does not take an '@' context: the class has no 'where' clause.");
                return;
            }
            const { mapper, broken } = classMapper(cls, instance!);
            if (broken) return;
            const evidence = resolveClause(cls, mapper, node, context);
            if (evidence) resolutions.calls.set(node, { evidence, method: false, contextArgument, context });
        };

        const baseInstanceOf = (node: TS.Node) => {
            let current = node.parent;
            while (current && !ts.isClassLike(current)) current = current.parent;
            if (!current) return undefined;
            const heritage = current.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
            return heritage && checker.getTypeAtLocation(heritage);
        };

        const analyzeSuperCall = (call: TS.CallExpression, context: TS.Expression | undefined, contextArgument: TS.Node | undefined) => {
            const instance = baseInstanceOf(call);
            const cls = instance && classOfType(instance);
            if (!cls || !syntax.wheres.has(cls)) return;
            const { mapper, broken } = classMapper(cls, instance!);
            if (broken) return;
            const evidence = resolveClause(cls, mapper, call, context);
            if (evidence) resolutions.calls.set(call, { evidence, method: false, contextArgument, context });
        };

        const checkClass = (cls: TS.ClassLikeDeclaration) => {
            checkClause(cls);
            const hasConstructor = cls.members.some(member => ts.isConstructorDeclaration(member) && !!member.body);
            if (hasConstructor) return;
            const heritage = cls.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
            const instance = heritage && checker.getTypeAtLocation(heritage);
            const base = instance && classOfType(instance);
            if (!base || !syntax.wheres.has(base)) return;
            const { mapper, broken } = classMapper(base, instance!);
            if (broken) return;
            const evidence = resolveClause(base, mapper, heritage!, undefined);
            if (evidence) resolutions.classes.set(cls, { baseEvidence: evidence });
        };

        /** A field initializer runs before the constructor can store a dictionary; only a function run later can read it. */
        const checkFieldUse = (call: TS.Node, cls: TS.ClassLikeDeclaration) => {
            for (let current: TS.Node = call; current && current !== cls; current = current.parent) {
                if (ts.isArrowFunction(current) || ts.isFunctionExpression(current) || ts.isMethodDeclaration(current) || ts.isConstructorDeclaration(current) || ts.isAccessor(current)) return;
                if (ts.isPropertyDeclaration(current)) {
                    report(call, codes.value, "A field initializer runs before the class has its dictionaries; read them in a method or the constructor.");
                    return;
                }
            }
        };

        /** Type references check a clause too, statically: a type mentioning a constrained type must be able to satisfy it. */
        const checkTypeUse = (node: TS.TypeReferenceNode | TS.ExpressionWithTypeArguments) => {
            const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
            const located = checker.getSymbolAtLocation(ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : name);
            if (!located) return;
            const symbol = resolveAlias(located);
            const declaration = symbol.declarations?.find(candidate => syntax.wheres.has(candidate) && !syntax.typeclasses.has(candidate));
            if (!declaration || !(ts.isClassLike(declaration) || ts.isInterfaceDeclaration(declaration) || ts.isTypeAliasDeclaration(declaration))) return;
            const parameterNodes = declaration.typeParameters ?? [];
            const argumentNodes = node.typeArguments ?? [];
            if (argumentNodes.length < parameterNodes.filter(parameter => !parameter.default).length) return;
            const sources = parameterNodes.slice(0, argumentNodes.length).map(parameter => checker.getTypeAtLocation(parameter) as TS.TypeParameter);
            const mapper = sources.length ? types.createMapper(sources, argumentNodes.slice(0, sources.length).map(typeOf)) : undefined;
            resolveClause(declaration, mapper, node, undefined, typeOnly.search);
        };

        const checkInherentBlock = (companion: TS.InterfaceDeclaration, block: InherentBlock) => {
            const problems = inherentLookup.problemsOfBlock(checker, sourceFile, companion, block, types);
            const anchor = { pos: block.start, end: block.start + 4 } as unknown as TS.Node;
            for (const problem of problems) report(anchor, codes.inherent, problem);
        };

        /** A typeclass only means something through its methods; `f.call(...)` would lose the dictionaries `f` expects. */
        const checkValueUse = (node: TS.Identifier) => {
            const parent = node.parent;
            if (ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent) || ts.isExportSpecifier(parent) || ts.isExportAssignment(parent)) return;
            if ((parent as { name?: TS.Node; }).name === node && !ts.isShorthandPropertyAssignment(parent)) return;
            if (ts.isTypeNode(parent) || ts.isQualifiedName(parent)) return;
            const located = ts.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node);
            if (!located) return;
            const symbol = resolveAlias(located);
            if (isTypeclassSymbol(symbol)) {
                const isMethodCall = ts.isPropertyAccessExpression(parent) && parent.expression === node && ts.isCallExpression(parent.parent) && parent.parent.expression === parent;
                if (!isMethodCall) report(node, codes.value, `The typeclass '${ts.idText(node)}' can only be used to call its methods, as in '${ts.idText(node)}.method(...)'.`);
                return;
            }
            const constrained = symbol.declarations?.some(declaration => syntax.wheres.has(declaration) && !syntax.impls.has(declaration) && ts.isFunctionLike(declaration) && typeclassItems(declaration, checker).length > 0);
            if (constrained && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
                report(node, codes.value, `'${ts.idText(node)}' needs implementations from its 'where' clause, so its 'call', 'apply', and 'bind' cannot be used.`);
            }
        };

        const checkInherentValueUse = (node: TS.PropertyAccessExpression) => {
            const member = checker.getSymbolAtLocation(node.name);
            const signature = member?.declarations?.find(ts.isMethodSignature);
            if (!signature || !syntax.inherent.has(signature.parent)) return;
            if (!(ts.isCallExpression(node.parent) && node.parent.expression === node)) report(node.name, codes.value, `The inherent method '${ts.idText(node.name as TS.Identifier)}' can only be called directly.`);
        };

        /** A signature with a clause and no name to refer to it by cannot be written in declaration output without losing it. */
        const hasUnwritableClause = (type: TS.Type, depth: number): boolean => {
            if (depth > 3 || !(type.flags & ts.TypeFlags.Object)) return false;
            for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
                const declaration = signature.declaration;
                if (declaration && syntax.wheres.has(declaration) && !ts.isFunctionDeclaration(declaration) && !ts.isMethodDeclaration(declaration)) return true;
                if (hasUnwritableClause(checker.getReturnTypeOfSignature(signature), depth + 1)) return true;
            }
            return false;
        };

        const checkInferredType = (node: TS.VariableDeclaration | TS.FunctionDeclaration) => {
            if (!options.declaration && !options.composite) return;
            if (node.type || !node.name || !ts.isIdentifier(node.name) || syntax.impls.has(node) || syntax.helpers.has(node)) return;
            const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node;
            if (statement.parent !== sourceFile || !ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
            const type = ts.isVariableDeclaration(node)
                ? checker.getTypeAtLocation(node)
                : checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(node)!);
            if (hasUnwritableClause(type, 0)) report(node.name, codes.inferred, `The inferred type of '${ts.idText(node.name)}' has a 'where' clause declaration output cannot write. Annotate it.`);
        };

        const visit = (node: TS.Node): void => {
            if (ts.isTypeReferenceNode(node)) checkTypeUse(node);
            else if (ts.isExpressionWithTypeArguments(node) && ts.isHeritageClause(node.parent)) checkTypeUse(node);
            if (ts.isInterfaceDeclaration(node)) {
                const block = syntax.inherent.get(node);
                if (block) {
                    checkInherentBlock(node, block);
                    return;
                }
                checkClause(node);
                if (syntax.typeclasses.has(node)) {
                    for (const item of syntax.wheres.get(node)?.items ?? []) {
                        if (!isTypeclassType(typeOf(item))) report(node.name, codes.declaration, `A typeclass can only require other typeclasses, and '${syntax.wheres.get(node)!.itemTexts.get(item)}' is not one.`);
                    }
                    return;
                }
            }
            else if (ts.isTypeAliasDeclaration(node)) checkClause(node);
            else if (ts.isClassLike(node)) checkClass(node);
            else if (ts.isFunctionLike(node) && syntax.wheres.has(node)) checkClause(node);
            if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) checkInferredType(node);
            if (ts.isFunctionDeclaration(node)) {
                checkOverloads(node);
                if (syntax.impls.has(node)) checkImpl(node);
            }
            else if (ts.isVariableDeclaration(node) && syntax.impls.has(node)) checkImpl(node);
            else if (ts.isCallExpression(node)) analyzeCall(node);
            else if (ts.isNewExpression(node)) analyzeNew(node);
            else if (ts.isIdentifier(node)) checkValueUse(node);
            else if (ts.isPropertyAccessExpression(node)) checkInherentValueUse(node);
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                for (const evidence of resolutions.calls.get(node)?.evidence ?? []) {
                    let root: Evidence = evidence;
                    while (root.kind === "superclass") root = root.of;
                    if (root.kind === "member") checkFieldUse(node, root.cls);
                }
            }
            if (!ts.isImportDeclaration(node)) ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    return {
        provider,
        constraint,
        resolutions: (checker, sourceFile) => results.get(checker)?.get(sourceFile),
        isUsedImportDiagnostic: diagnostic => (diagnostic.code === 6133 || diagnostic.code === 6192) && !!diagnostic.file && diagnostic.start !== undefined && usedImports.has(`${diagnostic.file.fileName}:${diagnostic.start}`),
        typeclassItems,
        rewordFieldDiagnostic(diagnostic) {
            if (diagnostic.code !== 2741 && diagnostic.code !== 2739) return undefined;
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
            const required = /(?:required in type|from type) '([\w$]+)/.exec(message)?.[1];
            if (!message.includes("(Missing)") || !required || !syntax.typeclassNames.has(required)) return undefined;
            return { ...diagnostic, messageText: `This dictionary of '${required}' is missing the '$' fields that hold its superclasses: write them, or declare it with 'impl'.` };
        },
        useOptions(next) {
            options = next;
        },
    };
}
