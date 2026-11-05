import type { TSPPDiagnosticProvider, TSPPSignatureConstraint, TSPPTypeExtension, TSPPTypeOperations, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { createEffectScope } from "./scope";
import type { EffectContext, EffectScope } from "./scope";
import type { EffectSyntax } from "./syntax";

const codes = {
    declaration: 19201,
    unavailable: 19202,
    instance: 19203,
    relation: 19204,
    value: 19205,
    isolated: 19206,
    inferred: 19207,
    perform: 19208,
    handle: 19209,
};

/** What a call passes: for each effect the callee requires, the context that offers it. */
export interface CallResolution {
    readonly needs: readonly { readonly name: string; readonly context: EffectContext; }[];
}

export interface PerformResolution {
    readonly name: string;
    readonly context: EffectContext;
}

export interface FileResolutions {
    readonly calls: Map<TS.Node, CallResolution>;
    readonly performs: Map<TS.Node, PerformResolution>;
}

export interface EffectChecks {
    readonly provider: TSPPDiagnosticProvider;
    readonly constraint: TSPPSignatureConstraint;
    readonly typeExtension: TSPPTypeExtension;
    /** What the provider found for `sourceFile`, once it has run with `checker`. */
    resolutions(checker: TS.TypeChecker, sourceFile: TS.SourceFile): FileResolutions | undefined;
    /** Whether a diagnostic reports an import as unused that only an effect clause or a `perform` names. */
    isUsedImportDiagnostic(diagnostic: TS.Diagnostic): boolean;
    /** The options of the program being checked. */
    useOptions(options: TS.CompilerOptions): void;
}

export function createEffectChecks(ts: TSPPTypeScript, syntax: EffectSyntax): EffectChecks {
    const results = new WeakMap<TS.TypeChecker, WeakMap<TS.SourceFile, FileResolutions>>();
    const usedImports = new Set<string>();
    let options: TS.CompilerOptions = {};

    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true);
    // Nodes have no `getStart` outside editor services, and the command line runs without those.
    const startOf = (node: TS.Node, sourceFile: TS.SourceFile) => {
        scanner.setText(sourceFile.text, node.pos);
        scanner.scan();
        return Math.min(scanner.getTokenStart(), node.end);
    };
    const keyOf = (node: TS.Node, sourceFile: TS.SourceFile) => `${sourceFile.fileName}:${startOf(node, sourceFile)}`;

    const isErrorType = (type: TS.Type) => !!(type.flags & ts.TypeFlags.Any) && (type as { intrinsicName?: string; }).intrinsicName === "error";

    const sameType = (checker: TS.TypeChecker, a: TS.Type, b: TS.Type) => a === b || (checker.isTypeAssignableTo(a, b) && checker.isTypeAssignableTo(b, a));

    const typeExtension: TSPPTypeExtension = {
        /** Only the name of a generic effect in a `perform` needs this: its type arguments are those where it is available. */
        resolveTypeNode(node, host) {
            if (!syntax.performEffects.has(node) || !ts.isTypeReferenceNode(node)) return undefined;
            const symbol = host.resolveTypeReferenceName(node);
            const scope = createEffectScope(ts, syntax, host.checker);
            if (!symbol || !scope.isEffect(symbol)) return undefined;
            if (!host.getTypeParametersOfSymbol(symbol)?.length) return undefined;
            return scope.find(symbol, node)?.entry.type ?? host.errorType;
        },
        instantiateType: type => type,
    };

    const constraint: TSPPSignatureConstraint = {
        isOverloadApplicable: () => true,
        whyNotRelated({ source, target, checker, instantiateSource, instantiateTarget }) {
            const sourceClause = source && syntax.clauses.get(source);
            const targetClause = target && syntax.clauses.get(target);
            if (!sourceClause && !targetClause) return undefined;
            // The overloads and implementation of one function are checked against each other by the provider.
            const symbolOf = (declaration: TS.Node | undefined) => (declaration as { symbol?: TS.Symbol; } | undefined)?.symbol;
            if (symbolOf(source) && symbolOf(source) === symbolOf(target)) return undefined;
            // Capabilities come first, so a function that does not expect them would read them as its first argument.
            if (!sourceClause || !targetClause) {
                return { code: codes.relation, message: sourceClause
                    ? "This function requires effects, so it cannot stand for a function that does not pass them: its capabilities come first."
                    : "A function with no effect clause cannot stand for one that passes capabilities, which come first: give it the same clause, or wrap it." };
            }
            const targetTypes = targetClause.items.map(item => instantiateTarget(checker.getTypeFromTypeNode(item)));
            for (const item of sourceClause.items) {
                const type = instantiateSource(checker.getTypeFromTypeNode(item));
                // A signature compared with its type parameters erased says nothing about them.
                const matches = (other: TS.Type) => type.symbol === other.symbol && (!!(type.flags & ts.TypeFlags.Any) || sameEffectArguments(checker, type, other));
                if (!targetTypes.some(matches)) return { code: codes.relation, message: `This function requires '${sourceClause.itemTexts.get(item)}', which a function of the expected type is not given.` };
            }
            return undefined;
        },
    };

    const typeArgumentsOf = (checker: TS.TypeChecker, type: TS.Type) => checker.getTypeArguments(type as TS.TypeReference);

    function sameEffectArguments(checker: TS.TypeChecker, a: TS.Type, b: TS.Type) {
        if (!((a as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference) || !((b as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference)) return a === b;
        const others = typeArgumentsOf(checker, b);
        return typeArgumentsOf(checker, a).every((argument, index) => !!(argument.flags & ts.TypeFlags.Any) || !!(others[index]?.flags & ts.TypeFlags.Any) || sameType(checker, argument, others[index]));
    }

    function analyze(sourceFile: TS.SourceFile, checker: TS.TypeChecker, types: TSPPTypeOperations, diagnostics: TS.Diagnostic[], resolutions: FileResolutions) {
        const scope: EffectScope = createEffectScope(ts, syntax, checker);
        const report = (node: TS.Node, code: number, message: string) => {
            const start = startOf(node, sourceFile);
            diagnostics.push({ file: sourceFile, start, length: node.end - start, messageText: message, category: ts.DiagnosticCategory.Error, code, source: "algebraic-effects" });
        };

        const resolveAlias = (symbol: TS.Symbol) => symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
        const show = (type: TS.Type) => checker.typeToString(type);

        const keepImport = (symbol: TS.Symbol) => {
            for (const declaration of symbol.declarations ?? []) {
                usedImports.add(keyOf(declaration, sourceFile));
                let statement: TS.Node = declaration;
                while (statement.parent && !ts.isImportDeclaration(statement)) statement = statement.parent;
                usedImports.add(keyOf(statement, sourceFile));
            }
        };

        /** A type only a clause names is written beside it in declaration output, as one a signature names is. */
        const keepNames = (node: TS.Node, visible: boolean): void => {
            if (ts.isTypeReferenceNode(node)) {
                let name: TS.EntityName = node.typeName;
                while (ts.isQualifiedName(name)) name = name.left;
                const symbol = checker.getSymbolAtLocation(name);
                if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
                    if (visible) types.markAliasVisibleInDeclarations(symbol);
                    keepImport(symbol);
                }
                else if (visible && symbol?.declarations?.some(declaration => declaration.parent === sourceFile)) types.markAliasVisibleInDeclarations(symbol);
            }
            ts.forEachChild(node, child => keepNames(child, visible));
        };

        const checkClause = (fn: TS.Node) => {
            const clause = syntax.clauses.get(fn)!;
            if (ts.isConstructorDeclaration(fn) || ts.isConstructorTypeNode(fn) || ts.isAccessor(fn)) report(fn, codes.declaration, "A constructor or accessor cannot require effects: nothing could pass it their capabilities.");
            const seen = new Map<string, TS.Symbol>();
            for (const item of clause.items) {
                keepNames(item, /*visible*/ true);
                const type = checker.getTypeFromTypeNode(item);
                const text = clause.itemTexts.get(item);
                if (isErrorType(type)) {
                    report(item, codes.declaration, `Cannot resolve the effect '${text}'.`);
                    continue;
                }
                const symbol = scope.effectOf(type);
                if (!symbol) {
                    report(item, codes.declaration, `'${text}' is not an effect.`);
                    continue;
                }
                const name = ts.symbolName(symbol);
                const earlier = seen.get(name);
                if (earlier === symbol) report(item, codes.declaration, `This clause already lists '${name}': a function can require one instance of an effect.`);
                else if (earlier) report(item, codes.declaration, `This clause lists two effects named '${name}', which share a capability: rename one.`);
                seen.set(name, symbol);
            }
        };

        const checkOverloads = (fn: TS.FunctionDeclaration) => {
            // All overloads and the implementation receive the same capabilities, so they must ask for the same effects.
            const symbol = fn.name && checker.getSymbolAtLocation(fn.name);
            const declarations = symbol?.declarations?.filter(ts.isFunctionDeclaration) ?? [];
            if (declarations.length < 2 || declarations[0] !== fn) return;
            const effects = (declaration: TS.FunctionDeclaration) => new Set((syntax.clauses.get(declaration)?.items ?? []).map(item => scope.effectOf(checker.getTypeFromTypeNode(item))));
            const first = effects(fn);
            for (const other of declarations.slice(1)) {
                const items = effects(other);
                if (items.size !== first.size || [...items].some(item => !first.has(item))) report(other.name ?? other, codes.declaration, "All overloads of a function and its implementation must require the same effects.");
            }
        };

        const missing = (name: string) => `The effect '${name}' is not available here: list it in the clause of the enclosing function ('/ ${name}') or handle it around this code.`;

        const checkPerform = (call: TS.CallExpression) => {
            const { effect } = syntax.performs.get(call)!;
            keepNames(effect, /*visible*/ false);
            const name = effect.typeName;
            const located = checker.getSymbolAtLocation(ts.isQualifiedName(name) ? name.right : name);
            const symbol = located && resolveAlias(located);
            // A name that resolves to nothing is the checker's to report.
            if (!symbol) return;
            if (!scope.isEffect(symbol)) {
                report(effect, codes.perform, `'${ts.symbolName(symbol)}' is not an effect, so 'perform' cannot take its operations.`);
                return;
            }
            const found = scope.find(symbol, call);
            if (!found) {
                report(effect, codes.unavailable, missing(ts.symbolName(symbol)));
                return;
            }
            resolutions.performs.set(call, { name: found.entry.name, context: found.context });
        };

        const checkHandle = (call: TS.CallExpression) => {
            const { effect } = syntax.handles.get(call)!;
            keepNames(effect, /*visible*/ false);
            const type = checker.getTypeFromTypeNode(effect);
            if (isErrorType(type)) return;
            const symbol = scope.effectOf(type);
            if (!symbol) {
                report(effect, codes.handle, `'${show(type)}' is not an effect, so it cannot be handled.`);
                return;
            }
            const name = ts.symbolName(symbol);
            const other = scope.contextsAt(call.parent).flatMap(context => scope.entriesOf(context)).find(entry => entry.name === name && entry.symbol !== symbol);
            if (other) report(effect, codes.handle, `Two effects named '${name}' would share a capability here: rename one.`);
        };

        const mapperOf = (call: TS.CallExpression, signature: TS.Signature, declaration: TS.SignatureDeclaration) => {
            const sources: TS.TypeParameter[] = [];
            const targets: TS.Type[] = [];
            const own = (declaration.typeParameters ?? []).map(parameter => checker.getTypeAtLocation(parameter) as TS.TypeParameter);
            const typeArguments = checker.getTypeArgumentsForResolvedSignature(signature);
            if (own.length) {
                if ((typeArguments?.length ?? 0) < own.length) return { broken: true };
                sources.push(...own);
                // An inferred literal, as in `f(1)`, asks for the instance at its type; a written `f<1>(1)` means the literal.
                targets.push(...typeArguments!.slice(0, own.length).map(argument => call.typeArguments ? argument : checker.getBaseTypeOfLiteralType(argument)));
            }
            const owner = declaration.parent;
            if ((ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) && ts.isPropertyAccessExpression(call.expression)) {
                const symbol = (owner as { symbol?: TS.Symbol; }).symbol;
                const parameters = symbol && (checker.getDeclaredTypeOfSymbol(symbol) as TS.InterfaceType).typeParameters;
                const receiver = checker.getTypeAtLocation(call.expression.expression);
                if (parameters?.length && receiver.symbol === symbol && (receiver as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
                    const receiverArguments = checker.getTypeArguments(receiver as TS.TypeReference);
                    if (receiverArguments.length >= parameters.length) {
                        sources.push(...parameters);
                        targets.push(...receiverArguments.slice(0, parameters.length));
                    }
                }
            }
            return { mapper: sources.length ? types.createMapper(sources, targets) : undefined };
        };

        const checkCall = (call: TS.CallExpression) => {
            const signature = checker.getResolvedSignature(call);
            const declaration = signature?.declaration;
            const clause = declaration && syntax.clauses.get(declaration);
            if (!clause) return;
            const { mapper, broken } = mapperOf(call, signature!, declaration as TS.SignatureDeclaration);
            if (broken) return;
            const needs: { name: string; context: EffectContext; }[] = [];
            let complete = true;
            for (const item of clause.items) {
                const declared = checker.getTypeFromTypeNode(item);
                const required = mapper ? types.instantiate(declared, mapper) : declared;
                const symbol = scope.effectOf(required);
                if (!symbol) {
                    complete = false;
                    continue;
                }
                const found = scope.find(symbol, call);
                if (!found) {
                    report(call, codes.unavailable, missing(show(required)));
                    complete = false;
                }
                else if (!sameType(checker, found.entry.type, required)) {
                    report(call, codes.instance, `This call requires '${show(required)}', but the '${ts.symbolName(symbol)}' in scope here is '${show(found.entry.type)}'. A type argument that nothing determines must be written out.`);
                    complete = false;
                }
                else needs.push({ name: found.entry.name, context: found.context });
            }
            if (complete) resolutions.calls.set(call, { needs });
        };

        const signatureHasClause = (type: TS.Type) => checker.getSignaturesOfType(type, ts.SignatureKind.Call).some(signature => !!signature.declaration && syntax.clauses.has(signature.declaration));

        /** `f.call(...)` and a tagged template would lose the capabilities `f` expects. */
        const checkValueUse = (node: TS.PropertyAccessExpression) => {
            const name = ts.idText(node.name as TS.Identifier);
            if ((name === "call" || name === "apply" || name === "bind") && signatureHasClause(checker.getTypeAtLocation(node.expression))) {
                report(node, codes.value, `This function requires effects, so its '${name}' cannot be used.`);
            }
        };

        /** A signature with a clause and no name to refer to it by cannot be written in declaration output without losing it. */
        const hasUnwritableClause = (type: TS.Type, depth: number): boolean => {
            if (depth > 3 || !(type.flags & ts.TypeFlags.Object)) return false;
            for (const signature of checker.getSignaturesOfType(type, ts.SignatureKind.Call)) {
                const declaration = signature.declaration;
                if (declaration && syntax.clauses.has(declaration) && !ts.isFunctionDeclaration(declaration) && !ts.isMethodDeclaration(declaration)) return true;
                if (hasUnwritableClause(checker.getReturnTypeOfSignature(signature), depth + 1)) return true;
            }
            return false;
        };

        const checkInferredType = (node: TS.VariableDeclaration | TS.FunctionDeclaration) => {
            if (!options.declaration && !options.composite) return;
            if (node.type || !node.name || !ts.isIdentifier(node.name)) return;
            const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node;
            if (statement.parent !== sourceFile || !ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) return;
            const type = ts.isVariableDeclaration(node)
                ? checker.getTypeAtLocation(node)
                : checker.getReturnTypeOfSignature(checker.getSignatureFromDeclaration(node)!);
            if (hasUnwritableClause(type, 0)) report(node.name, codes.inferred, `The inferred type of '${ts.idText(node.name)}' has an effect clause declaration output cannot write. Annotate it.`);
        };

        const visit = (node: TS.Node): void => {
            if (ts.isInterfaceDeclaration(node) && syntax.effects.has(node)) {
                for (const member of node.members) {
                    if (syntax.clauses.has(member)) report(member, codes.declaration, "An operation cannot require effects: its handler runs with those around the 'handle'.");
                }
            }
            if (ts.isFunctionLike(node) && syntax.clauses.has(node)) checkClause(node);
            if (ts.isFunctionDeclaration(node)) checkOverloads(node);
            if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) checkInferredType(node);
            if (ts.isCallExpression(node)) {
                if (syntax.performs.has(node)) checkPerform(node);
                else if (syntax.handles.has(node)) checkHandle(node);
                else checkCall(node);
            }
            else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) checkValueUse(node);
            else if (ts.isTaggedTemplateExpression(node) && signatureHasClause(checker.getTypeAtLocation(node.tag))) {
                report(node, codes.value, "This function requires effects, so it cannot be used as a template tag.");
            }
            if (!ts.isImportDeclaration(node)) ts.forEachChild(node, visit);
        };
        visit(sourceFile);
    }

    const provider: TSPPDiagnosticProvider = {
        id: "algebraic-effects",
        getSemanticDiagnostics(sourceFile, checker, types) {
            const diagnostics: TS.Diagnostic[] = [];
            if (!syntax.used() || sourceFile.isDeclarationFile) return diagnostics;
            const resolutions: FileResolutions = { calls: new Map(), performs: new Map() };
            analyze(sourceFile, checker, types, diagnostics, resolutions);
            if (options.isolatedModules) {
                for (const call of resolutions.calls.keys()) {
                    const start = startOf(call, sourceFile);
                    diagnostics.push({ file: sourceFile, start, length: call.end - start, messageText: "This call needs capabilities the checker finds across files, which 'isolatedModules' rules out: a tool that transpiles one file at a time cannot pass them.", category: ts.DiagnosticCategory.Error, code: codes.isolated, source: "algebraic-effects" });
                }
            }
            let forChecker = results.get(checker);
            if (!forChecker) results.set(checker, forChecker = new WeakMap());
            forChecker.set(sourceFile, resolutions);
            return diagnostics;
        },
    };

    return {
        provider,
        constraint,
        typeExtension,
        resolutions: (checker, sourceFile) => results.get(checker)?.get(sourceFile),
        isUsedImportDiagnostic: diagnostic => (diagnostic.code === 6133 || diagnostic.code === 6192) && !!diagnostic.file && diagnostic.start !== undefined && usedImports.has(`${diagnostic.file.fileName}:${diagnostic.start}`),
        useOptions(next) {
            options = next;
        },
    };
}
