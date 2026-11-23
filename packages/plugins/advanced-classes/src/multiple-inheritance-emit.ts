import { replaceChild } from "@tspp/plugin-sdk";
import type { TSPPProgramRebuilder, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { mixinKey, type MultipleInheritance } from "./multiple-inheritance";
import { findAdditionalBases } from "./multiple-inheritance-checks";

interface PrivateEntry {
    readonly kind: "field" | "method";
    /** A field's `WeakMap`, or a method's symbol key. */
    readonly name: TS.Identifier;
}

/** Emits each class used as an additional base as a factory of copies of itself, and the class itself as the first copy. */
export function createMultipleInheritanceEmit(ts: TSPPTypeScript, multiple: MultipleInheritance): TSPPProgramRebuilder {
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
            function $copy(extra, base, name, user) {
                const key = Symbol.for($key);
                const copy = Object.prototype.hasOwnProperty.call(extra, key) ? extra[key] : undefined;
                if (typeof copy !== "function") {
                    throw new TypeError("'" + name + "' cannot be used as an additional base of '" + user + "': it was compiled before this use. Compile the file that declares it again.");
                }
                return copy(base);
            }
        `, { copy: helpers.copy, key: f.createStringLiteral(mixinKey) });

        let usesHelpers = false;
        let usesCopy = false;
        const checkCopies = (node: TS.Node): TS.Node => {
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
        if (users.has(sourceFile.fileName)) statements = statements.map(statement => ts.visitNode(statement, checkCopies) as TS.Statement);
        const added = [...usesHelpers ? helperStatements : [], ...usesCopy ? copyHelper : []];
        if (!added.length) return f.updateSourceFile(sourceFile, statements);
        const prologue = statements.findIndex(statement => !(ts.isExpressionStatement(statement) && ts.isStringLiteral(statement.expression)));
        const at = prologue < 0 ? statements.length : prologue;
        return f.updateSourceFile(sourceFile, [...statements.slice(0, at), ...added, ...statements.slice(at)]);

        function emitFactory(declaration: TS.ClassDeclaration): TS.Statement[] {
            const name = ts.idText(declaration.name!);
            const classRef = f.createIdentifier(name);
            const brand = f.createUniqueName(`_${name}_brand`);
            const body = f.createUniqueName(`_${name}_body`);
            const base = f.createUniqueName("Base");

            const hasModifier = (member: TS.ClassElement, kind: TS.SyntaxKind) => ts.canHaveModifiers(member) && !!ts.getModifiers(member)?.some(modifier => modifier.kind === kind);
            const isStatic = (member: TS.ClassElement) => hasModifier(member, kinds.StaticKeyword);
            const isRuntime = (member: TS.ClassElement) => !hasModifier(member, kinds.AbstractKeyword) && !hasModifier(member, kinds.DeclareKeyword);

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

            const keyOf = (member: TS.PropertyDeclaration): TS.Expression =>
                ts.isIdentifier(member.name) ? f.createStringLiteral(ts.idText(member.name))
                : ts.isStringLiteral(member.name) || ts.isNumericLiteral(member.name) ? f.createStringLiteral(member.name.text)
                : (member.name as TS.ComputedPropertyName).expression;
            const thisMember = (target: TS.Expression, member: TS.PropertyDeclaration) => f.createElementAccessExpression(target, keyOf(member));
            const define = (target: TS.Expression, member: TS.PropertyDeclaration, value: TS.Expression) => snippet("Object.defineProperty($target, $key, { value: $value, writable: true, enumerable: true, configurable: true });", { target, key: keyOf(member), value })[0];

            // Instance fields run in order right after the base constructor; with private state they move into the constructor.
            const movesFields = privates.size > 0;
            const fieldStatements: TS.Statement[] = [];
            const members: TS.ClassElement[] = [];
            const staticStatements: TS.Statement[] = [];
            const staticNames: TS.Expression[] = [];
            let constructorBody: readonly TS.Statement[] = [];
            const runIn = (statementsOrValue: TS.Block | TS.Expression) => {
                const block = ts.isBlock(statementsOrValue) ? statementsOrValue : f.createBlock([f.createReturnStatement(statementsOrValue)], true);
                return f.createCallExpression(f.createPropertyAccessExpression(f.createParenthesizedExpression(f.createFunctionExpression(undefined, undefined, undefined, undefined, [], undefined, block)), "call"), undefined, [classRef]);
            };

            for (const member of declaration.members) {
                if (!isRuntime(member) && !ts.isConstructorDeclaration(member)) continue;
                if (ts.isConstructorDeclaration(member)) {
                    if (member.body) constructorBody = member.body.statements;
                    continue;
                }
                if (ts.isClassStaticBlockDeclaration(member)) {
                    staticStatements.push(f.createExpressionStatement(runIn(member.body)));
                    continue;
                }
                if (ts.isPropertyDeclaration(member)) {
                    if (isStatic(member)) {
                        staticNames.push(keyOf(member));
                        const value = member.initializer ? runIn(member.initializer) : f.createVoidZero();
                        if (useDefine) staticStatements.push(define(classRef, member, value));
                        else if (member.initializer) staticStatements.push(f.createExpressionStatement(f.createAssignment(thisMember(classRef, member), value)));
                        continue;
                    }
                    if (ts.isPrivateIdentifier(member.name)) {
                        const store = privates.get(ts.idText(member.name))!.name;
                        fieldStatements.push(f.createExpressionStatement(f.createCallExpression(f.createPropertyAccessExpression(store, "set"), undefined, [f.createThis(), member.initializer ?? f.createVoidZero()])));
                        continue;
                    }
                    if (movesFields) {
                        if (useDefine) fieldStatements.push(define(f.createThis(), member, member.initializer ?? f.createVoidZero()));
                        else if (member.initializer) fieldStatements.push(f.createExpressionStatement(f.createAssignment(thisMember(f.createThis(), member), member.initializer)));
                        continue;
                    }
                    members.push(member);
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
            const constructor = f.createConstructorDeclaration(undefined, [f.createParameterDeclaration(undefined, f.createToken(kinds.DotDotDotToken), args)], f.createBlock([
                f.createExpressionStatement(f.createCallExpression(f.createSuper(), undefined, [f.createSpreadElement(args)])),
                ...snippet("$brand.add(this);", { brand }),
                ...fieldStatements,
                ...constructorBody,
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
                ...snippet("const $brand = new WeakSet();", { brand }),
                f.createFunctionDeclaration(undefined, undefined, body, undefined, [f.createParameterDeclaration(undefined, undefined, base)], undefined, f.createBlock([f.createReturnStatement(rewritten)], true)),
                binding,
                ...snippet(`
                    Object.defineProperty($class, "name", { value: $name, configurable: true });
                    Object.defineProperty($class, Symbol.hasInstance, {
                        value: function (value) {
                            return this === $class ? $brand.has(value) : Function.prototype[Symbol.hasInstance].call(this, value);
                        },
                        writable: true,
                        configurable: true,
                    });
                    Object.defineProperty($class, Symbol.for($key), {
                        value: function (base) {
                            const copy = $body(base);
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
                `, { class: classRef, name: f.createStringLiteral(name), brand, body, key: f.createStringLiteral(mixinKey), statics: f.createArrayLiteralExpression(staticNames) }),
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
            return {
                // No statement is replaced, so the host keeps the program and only adds the transformer.
                replacements: new Map(),
                transformers: { before: [transformer] },
                onRebuilt: rebuilt => {
                    target = rebuilt;
                },
            };
        },
    };
}
