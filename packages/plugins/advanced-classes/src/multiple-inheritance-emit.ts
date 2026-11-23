import { replaceChild } from "@tspp/plugin-sdk";
import type { TSPPProgramRebuilder, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { mixinKey, type MultipleInheritance } from "./multiple-inheritance";
import { findAdditionalBases } from "./multiple-inheritance-checks";
import { resolveMappedIndex } from "./mapped-super-checks";
import { createQualifiedSuperEmit } from "./qualified-super-emit";

interface PrivateEntry {
    readonly kind: "field" | "method";
    /** A field's `WeakMap`, or a method's symbol key. */
    readonly name: TS.Identifier;
}

/** Emits each class used as an additional base as a factory of copies of itself, and the class itself as the first copy. */
export function createMultipleInheritanceEmit(ts: TSPPTypeScript, multiple: MultipleInheritance, registerProgram: (program: TS.Program) => void): TSPPProgramRebuilder {
    const kinds = ts.SyntaxKind;
    let target: TS.Program | undefined;
    const targetsByProgram = new WeakMap<TS.Program, ReturnType<typeof findAdditionalBases>>();
    const targetsOf = (program: TS.Program) => {
        let targets = targetsByProgram.get(program);
        if (!targets) targetsByProgram.set(program, targets = findAdditionalBases(ts, multiple, program));
        return targets;
    };

    /**
     * Statements parsed from `text`, with each `$name` replaced by `names[name]`. They are marked synthesized and have no
     * source positions, so that the emitter prints them from their own text and never asks the checker about them.
     */
    function snippet(text: string, names: Readonly<Record<string, TS.Expression>>): TS.Statement[] {
        const sourceFile = ts.createSourceFile("tspp-multiple-inheritance.js", text, ts.ScriptTarget.Latest, /*setParentNodes*/ true, ts.ScriptKind.JS);
        const visit = (node: TS.Node): void => {
            if (ts.isIdentifier(node) && ts.idText(node).startsWith("$")) {
                const replacement = names[ts.idText(node).slice(1)];
                if (!replacement) throw new Error(`No replacement for ${ts.idText(node)}`);
                replaceChild(node.parent, node, replacement);
                return;
            }
            ts.setTextRange(node, { pos: -1, end: -1 });
            (node as { flags: TS.NodeFlags; }).flags |= ts.NodeFlags.Synthesized;
            ts.forEachChild(node, visit, nodes => {
                ts.setTextRange(nodes, { pos: -1, end: -1 });
                nodes.forEach(visit);
            });
        };
        visit(sourceFile);
        return [...sourceFile.statements];
    }

    const transformer: TS.TransformerFactory<TS.SourceFile> = context => sourceFile => {
        const program = target;
        if (!program) return sourceFile;
        const { targets, users } = targetsOf(program);
        const declaresTarget = sourceFile.statements.some(statement => targets.has(ts.getOriginalNode(statement)));
        if (!declaresTarget && !users.has(sourceFile.fileName)) return sourceFile;
        const f = context.factory;
        const options = program.getCompilerOptions();
        const nativeFields = (options.target ?? ts.ScriptTarget.ES2022) >= ts.ScriptTarget.ES2022;
        const useDefine = options.useDefineForClassFields ?? (options.target ?? ts.ScriptTarget.ES2022) >= ts.ScriptTarget.ES2022;

        const helpers = {
            get: f.createUniqueName("__tsppPrivateGet"),
            set: f.createUniqueName("__tsppPrivateSet"),
            update: f.createUniqueName("__tsppPrivateUpdate"),
            method: f.createUniqueName("__tsppPrivateMethod"),
            copy: f.createUniqueName("__tsppAdditionalBase"),
        };
        const helperStatements = snippet(`
            function $get(store, receiver) {
                if (!store.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
                return store.get(receiver);
            }
            function $set(store, receiver, value) {
                if (!store.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
                store.set(receiver, value);
                return value;
            }
            function $update(store, receiver, prefix, increment) {
                let value = $get(store, receiver);
                const previous = increment ? value++ : value--;
                $set(store, receiver, value);
                return prefix ? value : previous;
            }
            function $method(brand, receiver, key) {
                if (!brand.has(receiver)) throw new TypeError("Receiver must be an instance of class");
                return receiver[key];
            }
        `, helpers);

        // Asks an additional base for its copy, and names the base when its file was emitted before this use.
        const copyHelper = snippet(`
            function $copy(extra, base, name, user, index) {
                const key = Symbol.for($key);
                const copy = Object.prototype.hasOwnProperty.call(extra, key) ? extra[key] : undefined;
                if (typeof copy !== "function") {
                    throw new TypeError("'" + name + "' cannot be used as an additional base of '" + user + "': it was compiled before this use. Compile the file that declares it again.");
                }
                return copy(base, index);
            }
        `, { copy: helpers.copy, key: f.createStringLiteral(mixinKey) });

        let usesHelpers = false;
        let usesCopy = false;
        const qualified = createQualifiedSuperEmit(ts, multiple, context, program.getTypeChecker());
        const checkCopies = (node: TS.Node): TS.VisitResult<TS.Node> => {
            if (multiple.isConstructorProbe(node) && ts.isNewExpression(node)) {
                return f.createArrayLiteralExpression(node.arguments?.map(argument => ts.visitNode(argument, checkCopies) as TS.Expression));
            }
            if (ts.isClassDeclaration(node)) {
                const info = multiple.getMultipleBases(node);
                if (info) {
                    const capture = f.createUniqueName("__tsppBases");
                    const binding = f.createVariableStatement(undefined, f.createVariableDeclarationList([
                        f.createVariableDeclaration(capture, undefined, undefined, f.createArrayLiteralExpression(info.bases)),
                    ], ts.NodeFlags.Const));
                    let current = qualified.rewrite(node, info, capture);
                    if (info.mapped) {
                        usesCopy = true;
                        let value: TS.Expression = f.createClassExpression(undefined, undefined, undefined, undefined, []);
                        info.mapped.entries.forEach((entry, order) => {
                            const index = resolveMappedIndex(ts, multiple, info, entry, program.getTypeChecker());
                            value = f.createCallExpression(helpers.copy, undefined, [f.createElementAccessExpression(capture, Math.max(0, index)), value,
                                f.createStringLiteral(multiple.entityText(info.bases[index] ?? entry.key)), f.createStringLiteral(info.name), f.createNumericLiteral(order)]);
                        });
                        current = f.updateClassDeclaration(current, current.modifiers, current.name, current.typeParameters,
                            current.heritageClauses?.map(clause => clause.token === kinds.ExtendsKeyword
                                ? f.updateHeritageClause(clause, [f.createExpressionWithTypeArguments(value, undefined)]) : clause), current.members);
                        return [binding, ts.visitEachChild(current, checkCopies, context)];
                    }
                    usesCopy = true;
                    let value: TS.Expression = f.createElementAccessExpression(capture, 0);
                    info.bases.slice(1).forEach((extra, offset) => {
                        value = f.createCallExpression(helpers.copy, undefined, [f.createElementAccessExpression(capture, offset + 1), value,
                            f.createStringLiteral(multiple.entityText(extra)), f.createStringLiteral(info.name)]);
                    });
                    current = f.updateClassDeclaration(current, current.modifiers, current.name, current.typeParameters,
                        current.heritageClauses?.map(clause => clause.token === kinds.ExtendsKeyword
                            ? f.updateHeritageClause(clause, [f.createExpressionWithTypeArguments(value, undefined)]) : clause), current.members);
                    return [binding, ts.visitEachChild(current, checkCopies, context)];
                }
            }
            const call = multiple.getCopyCall(node);
            if (call && ts.isCallExpression(node) && ts.isElementAccessExpression(node.expression)) {
                usesCopy = true;
                return f.createCallExpression(helpers.copy, undefined, [
                    ts.visitNode(node.expression.expression, checkCopies) as TS.Expression,
                    ts.visitNode(node.arguments[0], checkCopies) as TS.Expression,
                    f.createStringLiteral(call.text),
                    f.createStringLiteral(call.className),
                ]);
            }
            return ts.visitEachChild(node, checkCopies, context);
        };
        let statements: TS.Statement[] = [];
        for (const statement of sourceFile.statements) {
            if (ts.isClassDeclaration(statement) && targets.has(ts.getOriginalNode(statement))) statements.push(...emitFactory(statement));
            else statements.push(statement);
        }
        if (users.has(sourceFile.fileName)) statements = [...ts.visitNodes(f.createNodeArray(statements), checkCopies, ts.isStatement)];
        const added = [...usesHelpers ? helperStatements : [], ...usesCopy ? copyHelper : []];
        if (!added.length) return f.updateSourceFile(sourceFile, statements);
        const prologue = statements.findIndex(statement => !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)));
        const at = prologue < 0 ? statements.length : prologue;
        return f.updateSourceFile(sourceFile, [...statements.slice(0, at), ...added, ...statements.slice(at)]);

        function emitFactory(declaration: TS.ClassDeclaration): TS.Statement[] {
            const name = ts.idText(declaration.name!);
            const classRef = f.createIdentifier(name);
            const brand = f.createUniqueName(`_${name}_brand`);
            const prototypes = f.createUniqueName(`_${name}_prototypes`);
            const body = f.createUniqueName(`_${name}_body`);
            const base = f.createUniqueName("Base");
            const mode = f.createUniqueName("argumentIndex");

            const hasModifier = (member: TS.ClassElement, kind: TS.SyntaxKind) => ts.canHaveModifiers(member) && !!ts.getModifiers(member)?.some(modifier => modifier.kind === kind);
            const isStatic = (member: TS.ClassElement) => hasModifier(member, kinds.StaticKeyword);
            const isRuntime = (member: TS.ClassElement) => !hasModifier(member, kinds.AbstractKeyword) && !hasModifier(member, kinds.DeclareKeyword);

            const hoistPrivateInitializers = nativeFields && !useDefine && declaration.members.some(member =>
                ts.isPropertyDeclaration(member) && !isStatic(member) && isRuntime(member) && !ts.isPrivateIdentifier(member.name) && !!member.initializer);
            const privates = new Map<string, PrivateEntry>();
            const declarations: TS.Statement[] = [];
            for (const member of declaration.members) {
                if (!member.name || !ts.isPrivateIdentifier(member.name) || isStatic(member)) continue;
                const text = ts.idText(member.name);
                if (ts.isPropertyDeclaration(member)) {
                    const store = f.createUniqueName(`_${name}_${text.slice(1)}`);
                    privates.set(text, { kind: "field", name: store });
                    declarations.push(...snippet("const $store = new WeakMap();", { store }));
                }
                else if (ts.isMethodDeclaration(member)) {
                    const key = f.createUniqueName(`_${name}_${text.slice(1)}`);
                    privates.set(text, { kind: "method", name: key });
                    declarations.push(...snippet("const $key = Symbol($description);", { key, description: f.createStringLiteral(`${name}.${text}`) }));
                }
            }

            const fieldValue = (value: TS.Expression | undefined, member: TS.PropertyDeclaration): TS.Expression => {
                if (!value) return f.createVoidZero();
                const visit = (node: TS.Node): TS.Node => {
                    if (ts.isClassLike(node) || ts.isFunctionLike(node) && !ts.isArrowFunction(node)) return node;
                    if (ts.isMetaProperty(node) && node.keywordToken === kinds.NewKeyword) return f.createVoidZero();
                    return ts.visitEachChild(node, visit, context);
                };
                const rewritten = ts.visitNode(value, visit) as TS.Expression;
                let unwrapped = value;
                while (ts.isParenthesizedExpression(unwrapped)) unwrapped = unwrapped.expression;
                const anonymous = ts.isArrowFunction(unwrapped) || (ts.isFunctionExpression(unwrapped) || ts.isClassExpression(unwrapped)) && !unwrapped.name;
                const privateName = ts.isPrivateIdentifier(member.name);
                const inferred = privateName ? nativeFields && !hoistPrivateInitializers ? f.createStringLiteral(ts.idText(member.name)) : undefined
                    : useDefine ? nativeFields ? keyOf(member) : f.createStringLiteral("value") : undefined;
                return anonymous && inferred ? f.createElementAccessExpression(f.createObjectLiteralExpression([
                    f.createPropertyAssignment(f.createComputedPropertyName(inferred), rewritten),
                ]), inferred) : rewritten;
            };
            const keyOf = (member: TS.PropertyDeclaration): TS.Expression =>
                ts.isIdentifier(member.name) ? f.createStringLiteral(ts.idText(member.name))
                : ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name) ? f.createStringLiteral(member.name.text)
                : (member.name as TS.ComputedPropertyName).expression;
            const thisMember = (target: TS.Expression, member: TS.PropertyDeclaration) => f.createElementAccessExpression(target, keyOf(member));
            const define = (target: TS.Expression, member: TS.PropertyDeclaration, value: TS.Expression) => snippet("Object.defineProperty($target, $key, { value: $value, writable: true, enumerable: true, configurable: true });", { target, key: keyOf(member), value })[0];

            // Native fields precede parameter binding; downlevel/public assignment fields follow parameter properties.
            const fieldsBeforeParameters: TS.Statement[] = [];
            const fieldsAfterParameters: TS.Statement[] = [];
            const members: TS.ClassElement[] = [];
            const staticStatements: TS.Statement[] = [];
            const staticNames: TS.Expression[] = [];
            let constructorBody: readonly TS.Statement[] = [];
            let constructorParameters: readonly TS.ParameterDeclaration[] = [];
            const runIn = (statementsOrValue: TS.Block | TS.Expression) => {
                const block = ts.isBlock(statementsOrValue) ? statementsOrValue : f.createBlock([f.createReturnStatement(statementsOrValue)], true);
                return f.createCallExpression(f.createPropertyAccessExpression(f.createParenthesizedExpression(f.createFunctionExpression(undefined, undefined, undefined, undefined, [], undefined, block)), "call"), undefined, [classRef]);
            };

            for (const member of declaration.members) {
                if (!isRuntime(member) && !ts.isConstructorDeclaration(member)) continue;
                if (ts.isConstructorDeclaration(member)) {
                    if (member.body) { constructorBody = member.body.statements; constructorParameters = member.parameters; }
                    continue;
                }
                if (ts.isClassStaticBlockDeclaration(member)) {
                    staticStatements.push(f.createExpressionStatement(runIn(member.body)));
                    continue;
                }
                if (ts.isPropertyDeclaration(member)) {
                    const fieldStatements = nativeFields && (useDefine || ts.isPrivateIdentifier(member.name) && !hoistPrivateInitializers) ? fieldsBeforeParameters : fieldsAfterParameters;
                    if (isStatic(member)) {
                        staticNames.push(keyOf(member));
                        const value = member.initializer ? runIn(fieldValue(member.initializer, member)) : f.createVoidZero();
                        if (useDefine) staticStatements.push(define(classRef, member, value));
                        else if (member.initializer) staticStatements.push(f.createExpressionStatement(f.createAssignment(thisMember(classRef, member), value)));
                        continue;
                    }
                    if (ts.isPrivateIdentifier(member.name)) {
                        const store = privates.get(ts.idText(member.name))!.name;
                        if (hoistPrivateInitializers) fieldsBeforeParameters.push(f.createExpressionStatement(f.createCallExpression(f.createPropertyAccessExpression(store, "set"), undefined, [f.createThis(), f.createVoidZero()])));
                        fieldStatements.push(f.createExpressionStatement(f.createCallExpression(f.createPropertyAccessExpression(store, "set"), undefined, [f.createThis(), fieldValue(member.initializer, member)])));
                        continue;
                    }
                    if (useDefine) fieldStatements.push(define(f.createThis(), member, fieldValue(member.initializer, member)));
                    else if (member.initializer) fieldStatements.push(f.createExpressionStatement(f.createAssignment(thisMember(f.createThis(), member), fieldValue(member.initializer, member))));
                    continue;
                }
                if (ts.isMethodDeclaration(member) && ts.isPrivateIdentifier(member.name)) {
                    const key = privates.get(ts.idText(member.name))!.name;
                    members.push(f.updateMethodDeclaration(member, member.modifiers, member.asteriskToken, f.createComputedPropertyName(key), member.questionToken, member.typeParameters, member.parameters, member.type, member.body));
                    continue;
                }
                members.push(member);
            }

            const args = f.createUniqueName("args");
            const parameterProperties = constructorParameters.filter(parameter => parameter.modifiers?.some(modifier =>
                [kinds.PublicKeyword, kinds.ProtectedKeyword, kinds.PrivateKeyword, kinds.ReadonlyKeyword].includes(modifier.kind)) && ts.isIdentifier(parameter.name));
            const properties = parameterProperties.map(parameter => f.createExpressionStatement(f.createAssignment(
                f.createPropertyAccessExpression(f.createThis(), parameter.name as TS.Identifier), parameter.name as TS.Identifier)));
            const parameterFields = nativeFields && useDefine ? parameterProperties.flatMap(parameter => snippet("Object.defineProperty(this, $key, { value: undefined, writable: true, enumerable: true, configurable: true });", { key: f.createStringLiteral(ts.idText(parameter.name as TS.Identifier)) })) : [];
            const initialize = f.createArrowFunction(undefined, undefined, constructorParameters.map(parameter =>
                f.updateParameterDeclaration(parameter, undefined, parameter.dotDotDotToken, parameter.name, parameter.questionToken, parameter.type, parameter.initializer)), undefined,
                f.createToken(kinds.EqualsGreaterThanToken), f.createBlock([...nativeFields ? [] : snippet("$brand.add(this);", { brand }), ...properties, ...fieldsAfterParameters, ...constructorBody], true));
            const values = f.createConditionalExpression(f.createBinaryExpression(mode, kinds.EqualsEqualsEqualsToken, f.createVoidZero()), undefined, args, undefined,
                f.createConditionalExpression(f.createBinaryExpression(mode, kinds.EqualsEqualsEqualsToken, f.createNull()), undefined, f.createArrayLiteralExpression(), undefined,
                    f.createElementAccessExpression(f.createElementAccessExpression(args, 0), mode)));
            const constructor = f.createConstructorDeclaration(undefined, [f.createParameterDeclaration(undefined, f.createToken(kinds.DotDotDotToken), args)], f.createBlock([
                f.createExpressionStatement(f.createCallExpression(f.createSuper(), undefined, [f.createSpreadElement(args)])),
                ...nativeFields ? snippet("$brand.add(this);", { brand }) : [],
                ...parameterFields,
                ...fieldsBeforeParameters,
                f.createExpressionStatement(f.createCallExpression(f.createParenthesizedExpression(initialize), undefined, [f.createSpreadElement(values)])),
            ], true));
            const classExpression = f.createClassExpression(undefined, undefined, undefined, [f.createHeritageClause(kinds.ExtendsKeyword, [f.createExpressionWithTypeArguments(base, undefined)])], [constructor, ...members]);
            const rewritten = rewritePrivates(classExpression, privates, brand);
            const rewrittenStatics = staticStatements.map(statement => rewritePrivates(statement, privates, brand));

            const modifiers = ts.getModifiers(declaration) ?? [];
            const isExport = modifiers.some(modifier => modifier.kind === kinds.ExportKeyword);
            const isDefault = modifiers.some(modifier => modifier.kind === kinds.DefaultKeyword);
            // A local binding, exported by name: module transforms rewrite only the references they can resolve, and the
            // references written here have no symbol.
            const binding = f.createVariableStatement(
                undefined,
                f.createVariableDeclarationList([f.createVariableDeclaration(classRef, undefined, undefined, f.createCallExpression(body, undefined, [f.createClassExpression(undefined, undefined, undefined, undefined, [])]))], ts.NodeFlags.Let),
            );
            const exported = isDefault
                ? [f.createExportAssignment(undefined, undefined, classRef)]
                : isExport ? [f.createExportDeclaration(undefined, false, f.createNamedExports([f.createExportSpecifier(false, undefined, classRef)]))] : [];

            return [
                ...declarations,
                ...snippet("const $brand = new WeakSet(); const $prototypes = new WeakSet();", { brand, prototypes }),
                f.createFunctionDeclaration(undefined, undefined, body, undefined, [f.createParameterDeclaration(undefined, undefined, base), f.createParameterDeclaration(undefined, undefined, mode)], undefined, f.createBlock([f.createReturnStatement(rewritten)], true)),
                binding,
                ...snippet(`
                    Object.defineProperty($class, "name", { value: $name, configurable: true });
                    $prototypes.add($class.prototype);
                    Object.defineProperty($class, Symbol.hasInstance, {
                        value: function (value) {
                            if (this !== $class) return Function.prototype[Symbol.hasInstance].call(this, value);
                            if (value === null || typeof value !== "object" && typeof value !== "function") return false;
                            for (let prototype = Object.getPrototypeOf(value); prototype !== null; prototype = Object.getPrototypeOf(prototype)) {
                                if ($prototypes.has(prototype)) return true;
                            }
                            return false;
                        },
                        writable: true,
                        configurable: true,
                    });
                    Object.defineProperty($class, Symbol.for($key), {
                        value: function (base, index) {
                            const copy = $body(base, index === undefined ? null : index);
                            $prototypes.add(copy.prototype);
                            for (const name of $statics) {
                                Object.defineProperty(copy, name, {
                                    get: () => $class[name],
                                    set: value => { $class[name] = value; },
                                    enumerable: true,
                                    configurable: true,
                                });
                            }
                            return copy;
                        },
                    });
                `, { class: classRef, name: f.createStringLiteral(name), brand, prototypes, body, key: f.createStringLiteral(mixinKey), statics: f.createArrayLiteralExpression(staticNames) }),
                ...rewrittenStatics,
                ...exported,
            ];
        }

        /** Reads and writes of the class's private names through its stores, keys, and brand. */
        function rewritePrivates<T extends TS.Node>(root: T, privates: ReadonlyMap<string, PrivateEntry>, brand: TS.Identifier): T {
            if (!privates.size) return root;
            usesHelpers = true;
            let active = privates;
            const entryOf = (node: TS.Node) => ts.isPropertyAccessExpression(node) && ts.isPrivateIdentifier(node.name) ? active.get(ts.idText(node.name)) : undefined;
            /** The receiver once, and a name for reading it again: `this` and plain names stand for themselves. */
            const receiver = (expression: TS.Expression): [first: TS.Expression, again: TS.Expression] => {
                if (expression.kind === kinds.ThisKeyword || ts.isIdentifier(expression)) return [expression, expression];
                const temporary = f.createTempVariable(context.hoistVariableDeclaration);
                return [f.createAssignment(temporary, expression), temporary];
            };
            const call = (callee: TS.Identifier, ...args: TS.Expression[]) => f.createCallExpression(callee, undefined, args);
            const read = (entry: PrivateEntry, object: TS.Expression) =>
                entry.kind === "field" ? call(helpers.get, entry.name, object) : call(helpers.method, brand, object, entry.name);
            const compound: Partial<Record<TS.SyntaxKind, TS.BinaryOperator>> = {
                [kinds.PlusEqualsToken]: kinds.PlusToken,
                [kinds.MinusEqualsToken]: kinds.MinusToken,
                [kinds.AsteriskEqualsToken]: kinds.AsteriskToken,
                [kinds.AsteriskAsteriskEqualsToken]: kinds.AsteriskAsteriskToken,
                [kinds.SlashEqualsToken]: kinds.SlashToken,
                [kinds.PercentEqualsToken]: kinds.PercentToken,
                [kinds.LessThanLessThanEqualsToken]: kinds.LessThanLessThanToken,
                [kinds.GreaterThanGreaterThanEqualsToken]: kinds.GreaterThanGreaterThanToken,
                [kinds.GreaterThanGreaterThanGreaterThanEqualsToken]: kinds.GreaterThanGreaterThanGreaterThanToken,
                [kinds.AmpersandEqualsToken]: kinds.AmpersandToken,
                [kinds.BarEqualsToken]: kinds.BarToken,
                [kinds.CaretEqualsToken]: kinds.CaretToken,
            };
            const logical: Partial<Record<TS.SyntaxKind, TS.BinaryOperator>> = {
                [kinds.AmpersandAmpersandEqualsToken]: kinds.AmpersandAmpersandToken,
                [kinds.BarBarEqualsToken]: kinds.BarBarToken,
                [kinds.QuestionQuestionEqualsToken]: kinds.QuestionQuestionToken,
            };

            const visit = (node: TS.Node): TS.Node => {
                if (ts.isClassLike(node)) {
                    const shadowed = node.members.filter(member => member.name && ts.isPrivateIdentifier(member.name)).map(member => ts.idText(member.name as TS.PrivateIdentifier));
                    if (shadowed.some(name => active.has(name))) {
                        const saved = active;
                        active = new Map([...active].filter(([name]) => !shadowed.includes(name)));
                        try {
                            return ts.visitEachChild(node, visit, context);
                        }
                        finally {
                            active = saved;
                        }
                    }
                }
                if (ts.isBinaryExpression(node)) {
                    const operator = node.operatorToken.kind;
                    if (ts.isPrivateIdentifier(node.left) && operator === kinds.InKeyword) {
                        const entry = active.get(ts.idText(node.left));
                        if (entry) {
                            const set = entry.kind === "field" ? entry.name : brand;
                            return f.createCallExpression(f.createPropertyAccessExpression(set, "has"), undefined, [ts.visitNode(node.right, visit) as TS.Expression]);
                        }
                    }
                    const entry = entryOf(node.left);
                    if (entry?.kind === "field" && (operator === kinds.EqualsToken || compound[operator] || logical[operator])) {
                        const left = node.left as TS.PropertyAccessExpression;
                        const object = ts.visitNode(left.expression, visit) as TS.Expression;
                        const value = ts.visitNode(node.right, visit) as TS.Expression;
                        if (operator === kinds.EqualsToken) return call(helpers.set, entry.name, object, value);
                        const [first, again] = receiver(object);
                        const current = call(helpers.get, entry.name, again);
                        const result = compound[operator]
                            ? call(helpers.set, entry.name, again, f.createBinaryExpression(current, compound[operator]!, value))
                            : f.createBinaryExpression(current, logical[operator]!, call(helpers.set, entry.name, again, value));
                        return first === again ? result : f.createParenthesizedExpression(f.createCommaListExpression([first, result]));
                    }
                }
                if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === kinds.PlusPlusToken || node.operator === kinds.MinusMinusToken)) {
                    const entry = entryOf(node.operand);
                    if (entry?.kind === "field") {
                        const object = ts.visitNode((node.operand as TS.PropertyAccessExpression).expression, visit) as TS.Expression;
                        return call(helpers.update, entry.name, object, ts.isPrefixUnaryExpression(node) ? f.createTrue() : f.createFalse(), node.operator === kinds.PlusPlusToken ? f.createTrue() : f.createFalse());
                    }
                }
                if (ts.isCallExpression(node)) {
                    const entry = entryOf(node.expression);
                    if (entry) {
                        const [first, again] = receiver(ts.visitNode((node.expression as TS.PropertyAccessExpression).expression, visit) as TS.Expression);
                        const args = node.arguments.map(argument => ts.visitNode(argument, visit) as TS.Expression);
                        return f.createCallExpression(f.createPropertyAccessExpression(read(entry, first), "call"), undefined, [again, ...args]);
                    }
                }
                const entry = entryOf(node);
                if (entry) return read(entry, ts.visitNode((node as TS.PropertyAccessExpression).expression, visit) as TS.Expression);
                return ts.visitEachChild(node, visit, context);
            };
            return ts.visitEachChild(root, visit, context);
        }
    };

    return {
        id: "advanced-classes-multiple-inheritance",
        rebuild(program) {
            // Only classes with several bases need the program's emit changed.
            if (!multiple.used()) return undefined;
            target = program;
            registerProgram(program);
            return {
                // No statement is replaced, so the host keeps the program and only adds the transformer.
                replacements: new Map(),
                transformers: { before: [transformer] },
                onRebuilt: rebuilt => {
                    target = rebuilt;
                    registerProgram(rebuilt);
                },
            };
        },
    };
}
