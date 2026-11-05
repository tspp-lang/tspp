import type { TSPPProgramRebuilder, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { CallResolution, EffectChecks } from "./check";
import { createEffectScope } from "./scope";
import type { EffectContext } from "./scope";
import { createDriver as parseDriver } from "./driver";
import type { EffectSyntax, HandleSyntax } from "./syntax";

/** Passes capabilities in JavaScript output, and writes them as a parameter in the compatible `.d.ts`. */
export function createEffectEmit(ts: TSPPTypeScript, syntax: EffectSyntax, checks: EffectChecks): {
    readonly rebuilder: TSPPProgramRebuilder;
    readonly restoreCompatibility: (node: TS.Node) => string | undefined;
} {
    let target: TS.Program | undefined;
    const createDriver = (name: TS.Identifier) => parseDriver(ts, name);

    const sourceFileOf = (node: TS.Node) => {
        let current = node;
        while (current.parent) current = current.parent;
        return current as TS.SourceFile;
    };

    const transformer: TS.TransformerFactory<TS.SourceFile> = context => sourceFile => {
        const f = context.factory;
        const program = target!;
        // The file this program bound and checked, whatever transformers ran before this one.
        const original = program.getSourceFile(sourceFile.fileName);
        if (!original) return sourceFile;
        const checker = program.getTypeChecker();
        // `transpileModule` builds a program of one file, so nothing could say what this file's calls need.
        const perFile = !!program.getCompilerOptions().isolatedModules && !!program.getCompilerOptions().noResolve;
        if (perFile) {
            const needsProgram = (node: TS.Node): boolean => syntax.clauses.has(node) || syntax.performs.has(node) || syntax.handles.has(node) || !!ts.forEachChild(node, needsProgram);
            if (needsProgram(original)) throw new Error(`${sourceFile.fileName}: effects need the whole program, so this file cannot be transpiled on its own.`);
        }
        if (!checks.resolutions(checker, original)) program.getSemanticDiagnostics(original);
        const resolutions = checks.resolutions(checker, original);
        if (!resolutions) return sourceFile;
        const scope = createEffectScope(ts, syntax, checker);

        const names = new Map<TS.Node, TS.Identifier>();
        const nameOf = (context: EffectContext) => {
            const key = scope.keyOf(context);
            let name = names.get(key);
            if (!name) names.set(key, name = f.createUniqueName("$effects"));
            return name;
        };
        const capability = (context: EffectContext, name: string) => f.createPropertyAccessExpression(nameOf(context), name);

        /** What the object of `context` holds, by name: its own effects over those a `handle` copies from around it. */
        const contents = (context: EffectContext): ReadonlyMap<string, TS.Node> => {
            const held = new Map<string, TS.Node>();
            if (context.kind === "handle") {
                for (const outer of [...scope.contextsAt(context.handle.call.parent)].reverse()) {
                    for (const [name, key] of contents(outer)) held.set(name, key);
                }
            }
            for (const entry of scope.entriesOf(context)) held.set(entry.name, scope.keyOf(context));
            return held;
        };

        /** The object nearest to the call when it holds what the callee requires, which allocates nothing; otherwise a new one. */
        const capabilitiesFor = (source: TS.Node, { needs }: CallResolution): TS.Expression => {
            const nearest = scope.contextsAt(source)[0];
            if (nearest) {
                const held = contents(nearest);
                if (needs.every(need => held.get(need.name) === scope.keyOf(need.context))) return nameOf(nearest);
            }
            return f.createObjectLiteralExpression(needs.map(need => f.createPropertyAssignment(need.name, capability(need.context, need.name))));
        };

        const parameterFor = (fn: TS.Node) => f.createParameterDeclaration(undefined, undefined, nameOf({ kind: "clause", fn }));

        let driveName: TS.Identifier | undefined;
        const drive = () => driveName ??= f.createUniqueName("__tspp_drive");
        const asterisk = () => f.createToken(ts.SyntaxKind.AsteriskToken);

        /** Whether `node` reads `this` of the function it stands in, which an arrow function made a generator must keep. */
        const readsThis = (node: TS.Node): boolean =>
            node.kind === ts.SyntaxKind.ThisKeyword || !(ts.isFunctionLike(node) && !ts.isArrowFunction(node)) && !ts.isClassLike(node) && !!ts.forEachChild(node, readsThis);

        const lowerHandle = (handle: HandleSyntax): TS.Expression => {
            const self: EffectContext = { kind: "handle", handle };
            const entries = scope.entriesOf(self);
            const body = ts.visitEachChild(handle.body, visit, context);
            const outer = [...scope.contextsAt(handle.call.parent)].reverse().map(around => f.createSpreadAssignment(nameOf(around)));
            const capabilities = f.createObjectLiteralExpression([...outer, f.createPropertyAssignment(entries[0]?.name ?? "effect", visit(handle.handlers) as TS.Expression)]);
            const onReturn = handle.onReturn && visit(handle.onReturn) as TS.Expression;
            const parameter = f.createParameterDeclaration(undefined, undefined, nameOf(self));
            const returning = (value: TS.Expression) => onReturn ? f.createCallExpression(f.createParenthesizedExpression(onReturn), undefined, [value]) : value;
            if (!handle.control && !resolutions.generatorHandles.has(handle.call)) {
                const lowered = f.updateArrowFunction(body, body.modifiers, body.typeParameters, [parameter], body.type, body.equalsGreaterThanToken, body.body);
                return returning(f.createCallExpression(f.createParenthesizedExpression(lowered), undefined, [capabilities]));
            }
            // A body that suspends is a generator, started with the `this` of the code around it.
            const block = ts.isBlock(body.body) ? body.body : f.createBlock([f.createReturnStatement(body.body)]);
            const generator = f.createFunctionExpression(undefined, asterisk(), undefined, undefined, [parameter], undefined, block);
            const started = f.createCallExpression(f.createPropertyAccessExpression(f.createParenthesizedExpression(generator), "call"), undefined, [f.createThis(), capabilities]);
            // With `control` clauses the handle runs the body itself and promises its value; otherwise the generator it is in does.
            if (handle.control) return f.createCallExpression(drive(), undefined, onReturn ? [started, onReturn] : [started]);
            return returning(f.createParenthesizedExpression(f.createYieldExpression(asterisk(), started)));
        };

        const visit = (node: TS.Node): TS.Node => {
            const source = ts.getParseTreeNode(node) ?? node;
            if (ts.isCallExpression(node)) {
                const handle = syntax.handleResults.get(source);
                // Another plugin's transformer may look for what became of the parsed node, through its original.
                if (handle) return ts.setOriginalNode(lowerHandle(handle), node);
                const perform = resolutions.performs.get(source);
                const operation = syntax.performs.get(source)?.operation;
                if (perform && operation) {
                    const args = node.arguments.map(argument => visit(argument) as TS.Expression);
                    const handler = capability(perform.context, perform.name);
                    // A suspending operation yields `[handler, operation, arguments]` for the driver, which passes the continuation.
                    if (perform.suspends) return f.createParenthesizedExpression(f.createYieldExpression(undefined, f.createArrayLiteralExpression([handler, f.createStringLiteral(ts.idText(operation)), f.createArrayLiteralExpression(args)])));
                    return f.updateCallExpression(node, f.createPropertyAccessExpression(handler, ts.idText(operation)), undefined, args);
                }
                const call = resolutions.calls.get(source);
                if (call) {
                    const visited = ts.visitEachChild(node, visit, context);
                    const passed = f.updateCallExpression(visited, visited.expression, visited.typeArguments, [capabilitiesFor(source, call), ...visited.arguments]);
                    return call.colored ? f.createParenthesizedExpression(f.createYieldExpression(asterisk(), passed)) : passed;
                }
            }
            if (syntax.clauses.has(source)) {
                const star = scope.isColored(source) ? asterisk() : undefined;
                if (ts.isFunctionDeclaration(node) && node.body) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateFunctionDeclaration(visited, visited.modifiers, star ?? visited.asteriskToken, visited.name, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.body);
                }
                if (ts.isArrowFunction(node)) {
                    const visited = ts.visitEachChild(node, visit, context);
                    if (!star) return f.updateArrowFunction(visited, visited.modifiers, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.equalsGreaterThanToken, visited.body);
                    // An arrow function cannot be a generator, so it becomes a function expression bound to the same `this`.
                    const block = ts.isBlock(visited.body) ? visited.body : f.createBlock([f.createReturnStatement(visited.body)]);
                    const generator = f.createFunctionExpression(visited.modifiers as readonly TS.Modifier[] | undefined, star, undefined, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, block);
                    return readsThis(node.body) ? f.createCallExpression(f.createPropertyAccessExpression(f.createParenthesizedExpression(generator), "bind"), undefined, [f.createThis()]) : f.createParenthesizedExpression(generator);
                }
                if (ts.isFunctionExpression(node) && node.body) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateFunctionExpression(visited, visited.modifiers, star ?? visited.asteriskToken, visited.name, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.body);
                }
                if (ts.isMethodDeclaration(node) && node.body) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateMethodDeclaration(visited, visited.modifiers, star ?? visited.asteriskToken, visited.name, visited.questionToken, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.body);
                }
            }
            return ts.visitEachChild(node, visit, context);
        };
        const result = ts.visitEachChild(sourceFile, visit, context);
        if (!driveName) return result;
        return f.updateSourceFile(result, [createDriver(driveName), ...result.statements]);
    };

    const rebuilder: TSPPProgramRebuilder = {
        id: "effect-capabilities",
        rebuild(program) {
            if (!syntax.used()) return undefined;
            target = program;
            checks.useOptions(program.getCompilerOptions());
            return {
                // No statement is replaced, so the host keeps the program and only adds the transformer.
                replacements: new Map(),
                transformers: { before: [transformer] },
                filterDiagnostic: diagnostic => !checks.isUsedImportDiagnostic(diagnostic as never),
                onRebuilt: rebuilt => {
                    target = rebuilt;
                },
            };
        },
    };

    /** A signature as compatible output writes it, with its capabilities as a first parameter. */
    const compatibleNode = (node: TS.Node): TS.Node | undefined => {
        const clause = syntax.clauses.get(ts.getOriginalNode(node));
        if (!clause) return undefined;
        const f = ts.factory;
        const properties = clause.items.map(item => {
            const name = ts.isTypeReferenceNode(item) ? (ts.isQualifiedName(item.typeName) ? item.typeName.right : item.typeName) : undefined;
            return f.createPropertySignature(undefined, name ? ts.idText(name) : "effect", undefined, item);
        });
        const capabilities = f.createParameterDeclaration(undefined, undefined, "__effects", undefined, ts.setEmitFlags(f.createTypeLiteralNode(properties), ts.EmitFlags.SingleLine));
        // A function that may suspend is a generator of requests for whoever drives it.
        const colored = !!target && createEffectScope(ts, syntax, target.getTypeChecker()).isColored(ts.getOriginalNode(node));
        const unknown = () => f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
        const returns = (type: TS.TypeNode | undefined) => colored ? f.createTypeReferenceNode("Generator", [unknown(), type ?? unknown(), unknown()]) : type;
        if (ts.isFunctionDeclaration(node)) return f.createFunctionDeclaration(node.modifiers, node.asteriskToken, node.name, node.typeParameters, [capabilities, ...node.parameters], returns(node.type), undefined);
        if (ts.isMethodDeclaration(node)) return f.createMethodDeclaration(node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, [capabilities, ...node.parameters], returns(node.type), undefined);
        if (ts.isMethodSignature(node)) return f.createMethodSignature(node.modifiers, node.name, node.questionToken, node.typeParameters, [capabilities, ...node.parameters], returns(node.type));
        if (ts.isFunctionTypeNode(node)) return f.createFunctionTypeNode(node.typeParameters, [capabilities, ...node.parameters], returns(node.type) ?? unknown());
        return undefined;
    };

    const restoreCompatibility = (node: TS.Node) => {
        const compatible = compatibleNode(node);
        if (!compatible) return undefined;
        // Created rather than updated, and printed as compatible output: this signature restores no plugin clause.
        return ts.createPrinter({ removeComments: true, tsppCompatibilityDeclaration: true } as TS.PrinterOptions).printNode(ts.EmitHint.Unspecified, compatible, sourceFileOf(ts.getOriginalNode(node)));
    };

    return { rebuilder, restoreCompatibility };
}
