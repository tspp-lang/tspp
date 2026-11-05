import type { TSPPProgramRebuilder, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { CallResolution, Evidence, TypeclassEvidence } from "./evidence";
import type { TypeclassSyntax } from "./syntax";

/** Passes dictionaries in JavaScript output, and writes them as parameters in the compatible `.d.ts`. */
export function createTypeclassEmit(ts: TSPPTypeScript, syntax: TypeclassSyntax, evidence: TypeclassEvidence): {
    readonly rebuilder: TSPPProgramRebuilder;
    readonly restoreCompatibility: (node: TS.Node) => string | undefined;
} {
    let target: TS.Program | undefined;

    const isSimpleReference = (node: TS.Expression): boolean =>
        ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) && isSimpleReference(node.expression);

    /** The object literal's property initializers can be read directly when evaluating them has no effect. */
    const isSimpleLiteral = (node: TS.Expression): node is TS.ObjectLiteralExpression =>
        ts.isObjectLiteralExpression(node) && node.properties.every(property =>
            ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property) && !ts.isComputedPropertyName(property.name) && isSimpleReference(property.initializer));

    const typeclassName = (item: TS.TypeNode) => ts.isTypeReferenceNode(item) && ts.isIdentifier(item.typeName) ? ts.idText(item.typeName) : "dictionary";

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
        // `transpileModule` builds a program of one file, so no search could find what this file's syntax needs.
        const perFile = !!program.getCompilerOptions().isolatedModules && !!program.getCompilerOptions().noResolve;
        if (perFile) {
            const needsProgram = (node: TS.Node): boolean => syntax.wheres.has(node) || syntax.impls.has(node) || syntax.contexts.has(node) || !!ts.forEachChild(node, needsProgram);
            if (needsProgram(original)) throw new Error(`${sourceFile.fileName}: typeclasses and 'where' clauses need the whole program, so this file cannot be transpiled on its own.`);
        }
        if (!evidence.resolutions(checker, original)) program.getSemanticDiagnostics(original);
        const resolutions = evidence.resolutions(checker, original);
        if (!resolutions) return sourceFile;

        const parameterNames = new Map<TS.Node, TS.Identifier[]>();
        const parameterNamesOf = (declaration: TS.Node) => {
            let names = parameterNames.get(declaration);
            if (!names) {
                names = evidence.typeclassItems(declaration, checker).map(item => f.createUniqueName(`$${typeclassName(item)}`));
                parameterNames.set(declaration, names);
            }
            return names;
        };
        const fieldNames = new Map<TS.Node, TS.PrivateIdentifier[]>();
        const fieldNamesOf = (cls: TS.Node) => {
            let names = fieldNames.get(cls);
            if (!names) {
                names = evidence.typeclassItems(cls, checker).map(item => f.createUniquePrivateName(`#$${typeclassName(item)}`));
                fieldNames.set(cls, names);
            }
            return names;
        };

        /** What a method reads from `this` at its start, so nested functions can see it. */
        const prologues = new Map<TS.Node, Map<number, TS.Identifier>>();
        const memberExpression = (cls: TS.ClassLikeDeclaration, index: number, at: TS.Node): TS.Expression => {
            // The class itself stands for the constructor emit gives it, which has the dictionary as a parameter.
            if (at === cls) return parameterNamesOf(cls)[index];
            for (let current: TS.Node | undefined = at; current && current !== cls; current = current.parent) {
                if (ts.isConstructorDeclaration(current) && current.parent === cls) return parameterNamesOf(cls)[index];
                if ((ts.isMethodDeclaration(current) || ts.isAccessor(current)) && current.parent === cls) {
                    let reads = prologues.get(current);
                    if (!reads) prologues.set(current, reads = new Map());
                    let name = reads.get(index);
                    if (!name) reads.set(index, name = f.createUniqueName(`$${typeclassName(evidence.typeclassItems(cls, checker)[index])}`));
                    return name;
                }
            }
            return f.createPropertyAccessExpression(f.createThis(), fieldNamesOf(cls)[index]);
        };

        /** A name another file's import or this file's export may stand behind, which module output rewrites. */
        const referenceTo = (name: TS.Identifier) => ts.setOriginalNode(f.createIdentifier(ts.idText(name)), name);

        const expressionFor = (found: Evidence, at: TS.Node, authored: TS.Expression | undefined, temporary: TS.Identifier | undefined): TS.Expression => {
            switch (found.kind) {
                case "impl":
                    return referenceTo(found.name);
                case "parameter":
                    return parameterNamesOf(found.fn)[found.index];
                case "member":
                    return memberExpression(found.cls, found.index, at);
                case "superclass":
                    return f.createPropertyAccessExpression(expressionFor(found.of, at, authored, temporary), found.name);
                case "constructed":
                    return f.createCallExpression(expressionFor(found.constructor, at, authored, temporary), undefined, found.dictionaries.map(dictionary => expressionFor(dictionary, at, authored, temporary)));
                case "context": {
                    if (temporary) return f.createPropertyAccessExpression(temporary, found.property);
                    if (isSimpleLiteral(authored!)) {
                        const property = authored.properties.find(candidate => ts.idText(candidate.name as TS.Identifier) === found.property)!;
                        return ts.isPropertyAssignment(property) ? visit(property.initializer) as TS.Expression : referenceTo(property.name as TS.Identifier);
                    }
                    return f.createPropertyAccessExpression(visit(authored!) as TS.Expression, found.property);
                }
            }
        };

        const inherentImports = new Map<TS.SourceFile, { readonly declaration: TS.ImportDeclaration; readonly local: TS.Identifier; }>();
        /** The specifier that reaches `module` from this file: one it already imports, or a relative path. */
        const specifierFor = (module: TS.SourceFile) => {
            for (const statement of original.statements) {
                if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
                const symbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
                if (symbol?.valueDeclaration === module) return statement.moduleSpecifier.text.replace(/\.tspp$/, ".js");
            }
            const from = sourceFile.fileName.split("/").slice(0, -1);
            const to = module.fileName.replace(/(\.d)?\.tspp$/, "").split("/");
            let shared = 0;
            while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared++;
            const relative = [...from.slice(shared).map(() => ".."), ...to.slice(shared)].join("/");
            const resolution = program.getCompilerOptions().moduleResolution;
            const needsExtension = resolution === ts.ModuleResolutionKind.Node16 || resolution === ts.ModuleResolutionKind.NodeNext;
            return `${relative.startsWith(".") ? relative : `./${relative}`}${needsExtension ? ".js" : ""}`;
        };
        const helperReference = (helper: TS.FunctionDeclaration): TS.Expression => {
            const name = ts.idText(helper.name!);
            const module = sourceFileOf(helper);
            if (module === original) return f.createIdentifier(name);
            let entry = inherentImports.get(module);
            if (!entry) {
                const local = f.createUniqueName("$inherent");
                entry = { local, declaration: f.createImportDeclaration(undefined, f.createImportClause(undefined, undefined, f.createNamespaceImport(local)), f.createStringLiteral(specifierFor(module))) };
                inherentImports.set(module, entry);
            }
            return f.createPropertyAccessExpression(entry.local, name);
        };

        const lowerCall = (node: TS.CallExpression | TS.NewExpression, source: TS.Node, resolution: CallResolution): TS.Expression => {
            const { context: authored } = resolution;
            const temporary = authored && !isSimpleReference(authored) && !isSimpleLiteral(authored)
                ? f.createTempVariable(context.hoistVariableDeclaration)
                : undefined;
            const dictionaries = resolution.evidence.map(found => expressionFor(found, source, authored, temporary));
            const rest = (node.arguments ?? []).filter(argument => (ts.getParseTreeNode(argument) ?? argument) !== resolution.contextArgument).map(argument => visit(argument) as TS.Expression);
            let call: TS.Expression;
            if (ts.isNewExpression(node)) call = f.updateNewExpression(node, visit(node.expression) as TS.Expression, node.typeArguments, [...dictionaries, ...rest]);
            else if (resolution.method) call = f.updateCallExpression(node, f.createPropertyAccessExpression(dictionaries[0], (node.expression as TS.PropertyAccessExpression).name), undefined, rest);
            else if (resolution.receiverFirst) {
                const access = node.expression as TS.PropertyAccessExpression;
                const receiver = visit(access.expression) as TS.Expression;
                if (access.questionDotToken || node.questionDotToken) {
                    const held = f.createTempVariable(context.hoistVariableDeclaration);
                    const guarded = f.createCallExpression(helperReference(resolution.helper!), undefined, [...dictionaries, held, ...rest]);
                    call = f.createParenthesizedExpression(f.createConditionalExpression(f.createBinaryExpression(f.createAssignment(held, receiver), ts.SyntaxKind.EqualsEqualsToken, f.createNull()), undefined, f.createVoidZero(), undefined, guarded));
                }
                else call = f.createCallExpression(helperReference(resolution.helper!), undefined, [...dictionaries, receiver, ...rest]);
            }
            else if (resolution.helper) call = f.createCallExpression(helperReference(resolution.helper), undefined, [...dictionaries, ...rest]);
            else call = f.updateCallExpression(node, visit(node.expression) as TS.Expression, node.typeArguments, [...dictionaries, ...rest]);
            return temporary ? f.createParenthesizedExpression(f.createComma(f.createAssignment(temporary, visit(authored!) as TS.Expression), call)) : call;
        };

        const withPrologue = (source: TS.Node, block: TS.Block | undefined, cls: TS.ClassLikeDeclaration | undefined): TS.Block | undefined => {
            const reads = prologues.get(source);
            if (!reads || !block || !cls) return block;
            const statements = [...reads].map(([index, name]) => f.createVariableStatement(undefined, f.createVariableDeclarationList([f.createVariableDeclaration(name, undefined, undefined, f.createPropertyAccessExpression(f.createThis(), fieldNamesOf(cls)[index]))], ts.NodeFlags.Const)));
            return f.updateBlock(block, [...statements, ...block.statements]);
        };

        const lowerClass = (node: TS.ClassLikeDeclaration, source: TS.ClassLikeDeclaration): TS.ClassLikeDeclaration => {
            const visited = ts.visitEachChild(node, visit, context) as TS.ClassLikeDeclaration;
            const names = syntax.wheres.has(source) ? parameterNamesOf(source) : [];
            const fields = syntax.wheres.has(source) ? fieldNamesOf(source) : [];
            const base = resolutions.classes.get(source);
            if (!names.length && !base) return visited;
            const assignments = names.map((name, index) => f.createExpressionStatement(f.createAssignment(f.createPropertyAccessExpression(f.createThis(), fields[index]), name)));
            const parameters = names.map(name => f.createParameterDeclaration(undefined, undefined, name));
            const derived = visited.heritageClauses?.some(clause => clause.token === ts.SyntaxKind.ExtendsKeyword);
            const declaredFields: TS.ClassElement[] = fields.map(field => f.createPropertyDeclaration(undefined, field, undefined, undefined, undefined));
            let found = false;
            const members: TS.ClassElement[] = visited.members.map(member => {
                if (!ts.isConstructorDeclaration(member) || !member.body) return member;
                found = true;
                const statements = [...member.body.statements];
                const superIndex = statements.findIndex(statement => ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && statement.expression.expression.kind === ts.SyntaxKind.SuperKeyword);
                statements.splice(superIndex + 1, 0, ...assignments);
                return f.updateConstructorDeclaration(member, member.modifiers, [...parameters, ...member.parameters], f.updateBlock(member.body, statements));
            });
            if (!found) {
                const args = f.createUniqueName("args");
                const baseDictionaries = (base?.baseEvidence ?? []).map(dictionary => expressionFor(dictionary, source, undefined, undefined));
                const statements: TS.Statement[] = [
                    ...derived ? [f.createExpressionStatement(f.createCallExpression(f.createSuper(), undefined, [...baseDictionaries, f.createSpreadElement(args)]))] : [],
                    ...assignments,
                ];
                members.unshift(f.createConstructorDeclaration(undefined, [...parameters, ...derived ? [f.createParameterDeclaration(undefined, f.createToken(ts.SyntaxKind.DotDotDotToken), args)] : []], f.createBlock(statements, /*multiLine*/ true)));
            }
            const allMembers = [...declaredFields, ...members];
            return ts.isClassDeclaration(visited)
                ? f.updateClassDeclaration(visited, visited.modifiers, visited.name, visited.typeParameters, visited.heritageClauses, allMembers)
                : f.updateClassExpression(visited as TS.ClassExpression, visited.modifiers, visited.name, visited.typeParameters, visited.heritageClauses, allMembers);
        };

        const isExported = (name: string) => {
            const symbol = checker.getSymbolAtLocation(original);
            return !!symbol && checker.getExportsOfModule(symbol).some(candidate => ts.symbolName(candidate) === name);
        };

        const visit = (node: TS.Node): TS.Node => {
            const source = ts.getParseTreeNode(node) ?? node;
            if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
                const resolution = resolutions.calls.get(source);
                if (resolution) return lowerCall(node, source, resolution);
            }
            if (ts.isObjectLiteralExpression(node)) {
                const held = resolutions.superclasses.get(source);
                if (held?.length) {
                    const visited = ts.visitEachChild(node, visit, context);
                    return f.updateObjectLiteralExpression(visited, [...visited.properties, ...held.map(({ name, evidence: found }) => f.createPropertyAssignment(f.createIdentifier(name), expressionFor(found, source, undefined, undefined)))]);
                }
            }
            if (ts.isClassLike(node) && ts.isClassLike(source)) return lowerClass(node, source);
            if (ts.isFunctionDeclaration(node) && ts.isFunctionDeclaration(source)) {
                const helperOf = syntax.helpers.get(source);
                const names = syntax.wheres.has(source) ? parameterNamesOf(source) : [];
                if (!node.body) return ts.visitEachChild(node, visit, context);
                if (names.length || helperOf) {
                    const visited = ts.visitEachChild(node, visit, context);
                    const parameters = [...names.map(name => f.createParameterDeclaration(undefined, undefined, name)), ...visited.parameters];
                    // Module output reads the export from the original node, so an exported helper has none.
                    return helperOf && isExported(helperOf)
                        ? ts.setTextRange(f.createFunctionDeclaration([f.createModifier(ts.SyntaxKind.ExportKeyword), ...visited.modifiers ?? []], visited.asteriskToken, visited.name, visited.typeParameters, parameters, visited.type, visited.body), visited)
                        : f.updateFunctionDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, parameters, visited.type, visited.body);
                }
            }
            if (ts.isArrowFunction(node) && syntax.wheres.has(source)) {
                const names = parameterNamesOf(source);
                const visited = ts.visitEachChild(node, visit, context);
                return f.updateArrowFunction(visited, visited.modifiers, visited.typeParameters, [...names.map(name => f.createParameterDeclaration(undefined, undefined, name)), ...visited.parameters], visited.type, visited.equalsGreaterThanToken, visited.body);
            }
            if (ts.isFunctionExpression(node) && syntax.wheres.has(source) && node.body) {
                const names = parameterNamesOf(source);
                const visited = ts.visitEachChild(node, visit, context);
                return f.updateFunctionExpression(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.typeParameters, [...names.map(name => f.createParameterDeclaration(undefined, undefined, name)), ...visited.parameters], visited.type, visited.body);
            }
            if (ts.isMethodDeclaration(node) || ts.isAccessor(node)) {
                const names = ts.isMethodDeclaration(node) && syntax.wheres.has(source) ? parameterNamesOf(source) : [];
                const visited = ts.visitEachChild(node, visit, context) as TS.MethodDeclaration | TS.AccessorDeclaration;
                const cls = ts.isClassLike(source.parent) ? source.parent : undefined;
                const body = withPrologue(source, visited.body, cls);
                const parameters = [...names.map(name => f.createParameterDeclaration(undefined, undefined, name)), ...visited.parameters];
                if (ts.isMethodDeclaration(visited)) return f.updateMethodDeclaration(visited, visited.modifiers, visited.asteriskToken, visited.name, visited.questionToken, visited.typeParameters, parameters, visited.type, body);
                return ts.isGetAccessor(visited)
                    ? f.updateGetAccessorDeclaration(visited, visited.modifiers, visited.name, visited.parameters, visited.type, body)
                    : f.updateSetAccessorDeclaration(visited, visited.modifiers, visited.name, visited.parameters, body);
            }
            return ts.visitEachChild(node, visit, context);
        };
        const result = ts.visitEachChild(sourceFile, visit, context);
        if (!inherentImports.size) return result;
        return f.updateSourceFile(result, [...[...inherentImports.values()].map(entry => entry.declaration), ...result.statements]);
    };

    const rebuilder: TSPPProgramRebuilder = {
        id: "typeclass-dictionaries",
        rebuild(program) {
            if (!syntax.used()) return undefined;
            target = program;
            evidence.useOptions(program.getCompilerOptions());
            return {
                // No statement is replaced, so the host keeps the program and only adds the transformer.
                replacements: new Map(),
                transformers: { before: [transformer] },
                filterDiagnostic: diagnostic => !evidence.isUsedImportDiagnostic(diagnostic as never) && (evidence.rewordFieldDiagnostic(diagnostic as never) as never ?? true),
                onRebuilt: rebuilt => {
                    target = rebuilt;
                },
            };
        },
    };

    /** A declaration as compatible output writes it, with its dictionaries as parameters; undefined when it stays as it is. */
    const compatibleNode = (node: TS.Node): TS.Node | undefined => {
        const source = ts.getOriginalNode(node);
        const clause = syntax.wheres.get(source);
        if (!clause && !ts.isClassDeclaration(node) || !target || syntax.typeclasses.has(source)) return undefined;
        if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return undefined;
        const f = ts.factory;
        const checker = target.getTypeChecker();
        const items = new Set<TS.Node>(evidence.typeclassItems(source, checker));
        const predicates = (clause?.items ?? []).filter(item => !items.has(item));
        const singleLineTuple = (elements: readonly TS.TypeNode[]) => ts.setEmitFlags(f.createTupleTypeNode(elements), ts.EmitFlags.SingleLine);
        const counts = new Map<string, number>();
        const parameter = (base: string, type: TS.TypeNode | undefined, rest = false) => {
            const seen = (counts.get(base) ?? 0) + 1;
            counts.set(base, seen);
            return f.createParameterDeclaration(undefined, rest ? f.createToken(ts.SyntaxKind.DotDotDotToken) : undefined, seen > 1 ? `${base}${seen}` : base, undefined, type);
        };
        const dictionaries = [...items].map(item => parameter(`__${typeclassName(item as TS.TypeNode)}`, item as TS.TypeNode));

        if (ts.isClassDeclaration(node)) {
            let changed = dictionaries.length > 0;
            let found = false;
            const members: TS.ClassElement[] = node.members.map(member => {
                if (ts.isConstructorDeclaration(member)) {
                    found = true;
                    return dictionaries.length ? f.createConstructorDeclaration(member.modifiers, [...dictionaries, ...member.parameters], undefined) : member;
                }
                const compatible = compatibleNode(member) as TS.ClassElement | undefined;
                if (compatible) changed = true;
                return compatible ?? member;
            });
            if (!changed) return undefined;
            const derived = node.heritageClauses?.some(heritage => heritage.token === ts.SyntaxKind.ExtendsKeyword);
            if (!found && dictionaries.length) members.unshift(f.createConstructorDeclaration(undefined, [...dictionaries, ...derived ? [parameter("args", f.createArrayTypeNode(f.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword)), /*rest*/ true)] : []], undefined));
            return f.createClassDeclaration(node.modifiers, node.name, node.typeParameters, node.heritageClauses, members);
        }
        if (!ts.isFunctionDeclaration(node) && !ts.isMethodDeclaration(node) && !ts.isMethodSignature(node) && !ts.isFunctionTypeNode(node) && !ts.isConstructorTypeNode(node)) return undefined;

        // A predicate stays required: it makes the signature uncallable when it fails, and is never dropped.
        const hasRest = node.parameters.some(declaration => !!declaration.dotDotDotToken);
        const uncallable = predicates.length && hasRest ? [parameter("__where", f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword))] : [];
        const required = predicates.length && !hasRest
            ? [parameter("__where", predicates.reduceRight<TS.TypeNode>((rest, item) => f.createConditionalTypeNode(item as TS.TypeNode, f.createLiteralTypeNode(f.createTrue()), rest, singleLineTuple([f.createKeywordTypeNode(ts.SyntaxKind.NeverKeyword)])), singleLineTuple([])), /*rest*/ true)]
            : [];
        if (!dictionaries.length && !uncallable.length && !required.length) return undefined;
        const parameters = [...uncallable, ...dictionaries, ...node.parameters, ...required];
        // Created rather than updated, and printed as compatible output: this signature restores no plugin clause.
        if (ts.isFunctionDeclaration(node)) return f.createFunctionDeclaration(node.modifiers, node.asteriskToken, node.name, node.typeParameters, parameters, node.type, undefined);
        if (ts.isMethodDeclaration(node)) return f.createMethodDeclaration(node.modifiers, node.asteriskToken, node.name, node.questionToken, node.typeParameters, parameters, node.type, undefined);
        if (ts.isMethodSignature(node)) return f.createMethodSignature(node.modifiers, node.name, node.questionToken, node.typeParameters, parameters, node.type);
        if (ts.isFunctionTypeNode(node)) return f.createFunctionTypeNode(node.typeParameters, parameters, node.type);
        return f.createConstructorTypeNode(node.modifiers, node.typeParameters, parameters, node.type);
    };

    const restoreCompatibility = (node: TS.Node) => {
        const source = ts.getOriginalNode(node);
        if (syntax.inherent.has(source) || syntax.helpers.has(source)) return "";
        const compatible = compatibleNode(node);
        if (!compatible) return undefined;
        return ts.createPrinter({ removeComments: true, tsppCompatibilityDeclaration: true } as TS.PrinterOptions).printNode(ts.EmitHint.Unspecified, compatible, sourceFileOf(source));
    };

    return { rebuilder, restoreCompatibility };
}
