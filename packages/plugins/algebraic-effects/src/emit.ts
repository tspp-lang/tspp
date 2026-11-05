import type { TSPPProgramRebuilder, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { CallResolution, EffectChecks } from "./check";
import { createEffectScope } from "./scope";
import type { EffectContext } from "./scope";
import type { EffectSyntax, HandleSyntax } from "./syntax";

/** Passes capabilities in JavaScript output, and writes them as a parameter in the compatible `.d.ts`. */
export function createEffectEmit(ts: TSPPTypeScript, syntax: EffectSyntax, checks: EffectChecks): {
    readonly rebuilder: TSPPProgramRebuilder;
    readonly restoreCompatibility: (node: TS.Node) => string | undefined;
} {
    let target: TS.Program | undefined;

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

        const lowerHandle = (node: TS.CallExpression, handle: HandleSyntax): TS.Expression => {
            const self: EffectContext = { kind: "handle", handle };
            const entries = scope.entriesOf(self);
            const callee = node.expression as TS.ParenthesizedExpression;
            const body = ts.visitEachChild(callee.expression as TS.ArrowFunction, visit, context);
            const lowered = f.updateArrowFunction(body, body.modifiers, body.typeParameters, [f.createParameterDeclaration(undefined, undefined, nameOf(self))], body.type, body.equalsGreaterThanToken, body.body);
            const outer = [...scope.contextsAt(handle.call.parent)].reverse().map(around => f.createSpreadAssignment(nameOf(around)));
            const handlers = visit(handle.handlers) as TS.Expression;
            return f.updateCallExpression(node, f.updateParenthesizedExpression(callee, lowered), undefined, [
                f.createObjectLiteralExpression([...outer, f.createPropertyAssignment(entries[0]?.name ?? "effect", handlers)]),
            ]);
        };

        const visit = (node: TS.Node): TS.Node => {
            const source = ts.getParseTreeNode(node) ?? node;
            if (ts.isCallExpression(node)) {
                const handle = syntax.handles.get(source);
                if (handle) return lowerHandle(node, handle);
                const perform = resolutions.performs.get(source);
                const operation = syntax.performs.get(source)?.operation;
                if (perform && operation) {
                    return f.updateCallExpression(node, f.createPropertyAccessExpression(capability(perform.context, perform.name), ts.idText(operation)), undefined, node.arguments.map(argument => visit(argument) as TS.Expression));
                }
                const call = resolutions.calls.get(source);
                if (call) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateCallExpression(visited, visited.expression, visited.typeArguments, [capabilitiesFor(source, call), ...visited.arguments]);
                }
            }
            if (syntax.clauses.has(source)) {
                if (ts.isFunctionDeclaration(node) && node.body) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateFunctionDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.body);
                }
                if (ts.isArrowFunction(node)) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateArrowFunction(visited, visited.modifiers, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.equalsGreaterThanToken, visited.body);
                }
                if (ts.isFunctionExpression(node) && node.body) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateFunctionExpression(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.body);
                }
                if (ts.isMethodDeclaration(node) && node.body) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateMethodDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.questionToken, visited.typeParameters, [parameterFor(source), ...visited.parameters], visited.type, visited.body);
                }
            }
            return ts.visitEachChild(node, visit, context);
        };
        return ts.visitEachChild(sourceFile, visit, context);
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
        if (ts.isFunctionDeclaration(node)) return f.createFunctionDeclaration(node.modifiers, node.asteriskToken, node.name, node.typeParameters, [capabilities, ...node.parameters], node.type, undefined);
        if (ts.isMethodDeclaration(node)) return f.createMethodDeclaration(node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, [capabilities, ...node.parameters], node.type, undefined);
        if (ts.isMethodSignature(node)) return f.createMethodSignature(node.modifiers, node.name, node.questionToken, node.typeParameters, [capabilities, ...node.parameters], node.type);
        if (ts.isFunctionTypeNode(node)) return f.createFunctionTypeNode(node.typeParameters, [capabilities, ...node.parameters], node.type);
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
