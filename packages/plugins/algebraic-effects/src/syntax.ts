import { createLoweredArrowToken, markGenerated } from "@tspp/plugin-sdk";
import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

export const syntaxErrorCode = 19200;

/** The `/ { A, B }` of a signature. */
export interface EffectClause {
    readonly items: readonly TS.TypeNode[];
    /** Each item as written, since a generated copy has no source text to read. */
    readonly itemTexts: ReadonlyMap<TS.TypeNode, string>;
    /** The clause as written, for `.d.tspp` output. */
    readonly text: string;
}

/** What a `handle` lowered to. */
export interface HandleSyntax {
    /** The call `((__tspp_handler) => { body })(handlers satisfies E)`. */
    readonly call: TS.CallExpression;
    readonly effect: TS.TypeNode;
    readonly body: TS.ArrowFunction;
    readonly handlers: TS.Expression;
}

/** What a `perform` lowered to. */
export interface PerformSyntax {
    /** The type reference that names the effect, whose type arguments come from where it is available. */
    readonly effect: TS.TypeReferenceNode;
    readonly operation: TS.Identifier;
}

/** Finds what was recorded for a parsed node, also from the copy a program rebuild made of it. */
export interface SyntaxTable<T> {
    get(node: TS.Node): T | undefined;
    has(node: TS.Node): boolean;
}

/** What parsing leaves for checking and emit: ordinary TypeScript, and these tables of what it stands for. */
export interface EffectSyntax {
    readonly extensions: readonly TSPPSyntaxExtension[];
    /** The interfaces `effect` declarations lower to. */
    readonly effects: SyntaxTable<true>;
    readonly clauses: SyntaxTable<EffectClause>;
    /** By the call a `perform` lowered to. */
    readonly performs: SyntaxTable<PerformSyntax>;
    /** The type references of `perform`s, by which the type extension knows them. */
    readonly performEffects: SyntaxTable<true>;
    /** By the inner call of a `handle`. */
    readonly handles: SyntaxTable<HandleSyntax>;
    /** By the function that holds the body of a `handle`. */
    readonly handleBodies: SyntaxTable<HandleSyntax>;
    /** Whether any syntax of this plugin has been parsed in this process. */
    readonly used: () => boolean;
}

/**
 * Lowers while parsing, so the checker and the language service see ordinary TypeScript:
 *
 * - `effect Logger { info(msg: string): void; }` becomes `interface Logger { ... }`, and leaves no JavaScript.
 * - `perform Logger.info("x")` becomes `(null! as Logger).info("x")`; the checker's view of `Logger` there comes from the
 *   type extension, and emit puts the capability in place of the receiver.
 * - `handle Logger { ... } in { body }` becomes `((__tspp_handler) => { body })({ ... } satisfies Logger)`, passed through
 *   the `return` clause when there is one. Emit makes the argument the capabilities the body sees.
 * - `/ { A, B }` leaves the signature as it is and only records its items, whose kinds need names to be bound.
 */
export function createEffectSyntax(ts: TSPPTypeScript): EffectSyntax {
    const kinds = ts.SyntaxKind;
    const effects = new WeakMap<TS.Node, true>();
    const clauses = new WeakMap<TS.Node, EffectClause & { readonly holder: TS.Node; }>();
    const performs = new WeakMap<TS.Node, PerformSyntax>();
    const performEffects = new WeakMap<TS.Node, true>();
    const handles = new WeakMap<TS.Node, HandleSyntax>();
    const handleBodies = new WeakMap<TS.Node, HandleSyntax>();
    const restored = new WeakMap<TS.Node, string>();
    let used = false;

    const table = <T>(entries: WeakMap<TS.Node, T>, found?: (node: TS.Node, entry: T) => void): SyntaxTable<T> => ({
        get(node) {
            const entry = entries.get(node) ?? entries.get(ts.getOriginalNode(node));
            if (entry !== undefined) found?.(node, entry);
            return entry;
        },
        has: node => entries.has(node) || entries.has(ts.getOriginalNode(node)),
    });

    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true);
    const tokenStart = (text: string, pos: number) => {
        scanner.setText(text, pos);
        scanner.scan();
        return scanner.getTokenStart();
    };

    const setParents = (node: TS.Node, parent: TS.Node): void => {
        (node as { parent: TS.Node; }).parent = parent;
        ts.forEachChild(node, child => setParents(child, node));
    };

    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T => ts.setTextRange(node, { pos, end });

    const isWordFollowedByName = (cursor: TSPPSyntaxCursor, word: string) =>
        cursor.tokenText() === word && cursor.lookAhead(() => cursor.nextToken() === kinds.Identifier && !cursor.hasPrecedingLineBreak());

    const isName = (text: string) => /^[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*$/u.test(text);

    /** A name after a dot or in a handler, where TypeScript takes any word. */
    const parseAnyName = (cursor: TSPPSyntaxCursor): TS.Identifier => {
        const pos = cursor.getNodePos();
        const text = cursor.tokenText();
        if (!isName(text)) return cursor.parseIdentifier();
        cursor.nextToken();
        return cursor.finishNode(cursor.factory.createIdentifier(text), pos);
    };

    /** `/ E` or `/ { A, B }` at the current token. */
    const parseClause = (cursor: TSPPSyntaxCursor): EffectClause => {
        const text = cursor.getSourceText();
        const start = cursor.getTokenStart();
        cursor.nextToken();
        const items: TS.TypeNode[] = [];
        if (cursor.parseOptional(kinds.OpenBraceToken)) {
            while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
                items.push(cursor.parseType());
                if (!cursor.parseOptional(kinds.CommaToken)) break;
            }
            cursor.parseExpected(kinds.CloseBraceToken);
        }
        else items.push(cursor.parseType());
        const end = cursor.getNodePos();
        if (!items.length) cursor.parseErrorAt(start, end, "An effect clause must list at least one effect.", syntaxErrorCode);
        const itemTexts = new Map<TS.TypeNode, string>();
        for (const item of items) itemTexts.set(item, text.slice(tokenStart(text, item.pos), item.end));
        return { items, itemTexts, text: text.slice(start, end).trimEnd() };
    };

    /**
     * Hangs the items from what the binder and name resolution see in `declaration`. Name resolution only lets a function's
     * type parameters reach what hangs from a parameter or the return type, so they hang from an unused parameter.
     */
    const attachClause = (f: TS.NodeFactory, declaration: TS.Node, clause: EffectClause) => {
        // Refactors walk up from a name to what contains it, so all but the generated name have the range of the items.
        const items = { pos: clause.items[0]?.pos ?? -1, end: clause.items[clause.items.length - 1]?.end ?? -1 };
        const tuple = ts.setTextRange(f.createTupleTypeNode(ts.setTextRange(f.createNodeArray(clause.items), items)), items);
        const name = ts.setTextRange(f.createIdentifier("__tspp_effects"), { pos: -1, end: -1 });
        const holder = ts.setTextRange(f.createParameterDeclaration(undefined, undefined, name, undefined, tuple), items);
        setParents(holder, declaration);
        clauses.set(declaration, { ...clause, holder });
    };

    const clauseExtension: TSPPSyntaxExtension = {
        position: "function-clause",
        startTokens: [kinds.SlashToken],
        keywords: ["/"],
        isStart: cursor => cursor.lookAhead(() => {
            const next = cursor.nextToken();
            return next === kinds.OpenBraceToken || next === kinds.Identifier;
        }),
        parse(cursor) {
            used = true;
            const clause = parseClause(cursor);
            const text = cursor.getSourceText();
            const f = cursor.factory;
            return (declaration: TS.Node) => {
                attachClause(f, declaration, clause);
                // Declarations with no body to print restore as written; the others write their clause where it stands.
                if (ts.isMethodSignature(declaration) || ts.isFunctionTypeNode(declaration)) {
                    restored.set(declaration, text.slice(tokenStart(text, declaration.pos), declaration.end).trimEnd());
                }
            };
        },
        restoreFunctionClause: node => clauses.get(node)?.text ?? clauses.get(ts.getOriginalNode(node))?.text,
        getBoundChild: node => (clauses.get(node) ?? clauses.get(ts.getOriginalNode(node)))?.holder,
        restoreDeclaration: node => restored.get(ts.getOriginalNode(node)),
    };

    const effectDeclaration: TSPPSyntaxExtension = {
        position: "declaration",
        startTokens: [kinds.Identifier],
        keywords: ["effect"],
        isStart: cursor => isWordFollowedByName(cursor, "effect"),
        parse(cursor) {
            used = true;
            const f = cursor.factory;
            const pos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            cursor.nextToken();
            const name = cursor.parseIdentifier();
            const typeParameters = cursor.parseTypeParameters();
            if (cursor.token() !== kinds.OpenBraceToken) cursor.parseExpected(kinds.OpenBraceToken);
            const body = cursor.parseType();
            const end = cursor.getNodePos();
            const members = ts.isTypeLiteralNode(body) ? body.members : f.createNodeArray<TS.TypeElement>([]);
            for (const member of members) {
                if (!ts.isMethodSignature(member)) cursor.parseErrorAt(member.pos, member.end, "An effect may only declare operations, written as methods.", syntaxErrorCode);
            }
            const declaration = cursor.finishNode(f.createInterfaceDeclaration(cursor.modifiers as readonly TS.ModifierLike[] | undefined, name, typeParameters, undefined, members), cursor.modifiers?.pos ?? pos, end);
            effects.set(declaration, true);
            const prefix = (cursor.modifiers ?? []).map(modifier => `${ts.tokenToString(modifier.kind)} `).join("");
            restored.set(declaration, `${prefix}${cursor.getSourceText().slice(start, end).trimEnd()}`);
            return declaration;
        },
        restoreDeclaration: node => restored.get(ts.getOriginalNode(node)),
    };

    const performExpression: TSPPSyntaxExtension = {
        position: "primary-expression",
        startTokens: [kinds.Identifier],
        keywords: ["perform"],
        isStart: cursor => isWordFollowedByName(cursor, "perform"),
        parse(cursor) {
            used = true;
            const f = cursor.factory;
            const pos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            cursor.nextToken();
            const names = [cursor.parseIdentifier()];
            while (cursor.parseOptional(kinds.DotToken)) names.push(parseAnyName(cursor));
            const operation = names.pop()!;
            if (!names.length) cursor.parseErrorAt(start, operation.end, "'perform' takes an operation of an effect, as in 'perform Effect.operation(...)'.", syntaxErrorCode);
            const typeName = names.slice(1).reduce<TS.EntityName>((left, right) => cursor.finishNode(f.createQualifiedName(left, right), left.pos, right.end), names[0] ?? operation);
            const effect = cursor.finishNode(f.createTypeReferenceNode(typeName), typeName.pos, typeName.end);
            const typeArguments = cursor.parseTypeArguments();
            cursor.parseExpected(kinds.OpenParenToken);
            const argumentsPos = cursor.getNodePos();
            const args: TS.Expression[] = [];
            while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
                const argumentPos = cursor.getNodePos();
                if (cursor.parseOptional(kinds.DotDotDotToken)) args.push(cursor.finishNode(f.createSpreadElement(cursor.parseAssignmentExpression()), argumentPos));
                else args.push(cursor.parseAssignmentExpression());
                if (!cursor.parseOptional(kinds.CommaToken)) break;
            }
            const argumentList = range(f.createNodeArray(args), argumentsPos, cursor.getNodePos());
            cursor.parseExpected(kinds.CloseParenToken);
            const nothing = markGenerated(ts, f.createNonNullExpression(f.createNull()), start);
            const held = cursor.finishNode(f.createAsExpression(nothing, effect), pos, effect.end);
            const receiver = cursor.finishNode(f.createParenthesizedExpression(held), pos, effect.end);
            const access = cursor.finishNode(f.createPropertyAccessExpression(receiver, operation), pos, operation.end);
            const call = cursor.finishNode(f.createCallExpression(access, typeArguments, argumentList), pos);
            performs.set(call, { effect, operation });
            performEffects.set(effect, true);
            return call;
        },
    };

    /** `name(parameters): type { ... }` of a handler, from just after the name. */
    const parseHandlerMethod = (cursor: TSPPSyntaxCursor, pos: number, name: TS.Identifier) => {
        const f = cursor.factory;
        const typeParameters = cursor.parseTypeParameters();
        const parametersPos = cursor.getNodePos();
        cursor.parseExpected(kinds.OpenParenToken);
        const parameters: TS.ParameterDeclaration[] = [];
        while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
            const parameterPos = cursor.getNodePos();
            const rest = cursor.token() === kinds.DotDotDotToken ? f.createToken(kinds.DotDotDotToken) : undefined;
            if (rest) {
                cursor.finishNode(rest, parameterPos);
                cursor.nextToken();
            }
            const binding = cursor.parseBindingName();
            const question = cursor.token() === kinds.QuestionToken ? f.createToken(kinds.QuestionToken) : undefined;
            if (question) {
                cursor.finishNode(question, cursor.getNodePos());
                cursor.nextToken();
            }
            const type = cursor.parseTypeAnnotation();
            const initializer = cursor.parseOptional(kinds.EqualsToken) ? cursor.parseAssignmentExpression() : undefined;
            parameters.push(cursor.finishNode(f.createParameterDeclaration(undefined, rest, binding, question, type, initializer), parameterPos));
            if (!cursor.parseOptional(kinds.CommaToken)) break;
        }
        const parameterList = range(f.createNodeArray(parameters), parametersPos, cursor.getNodePos());
        cursor.parseExpected(kinds.CloseParenToken);
        const returnType = cursor.parseTypeAnnotation();
        const body = cursor.token() === kinds.OpenBraceToken ? cursor.parseStatement() : undefined;
        if (!body) cursor.parseExpected(kinds.OpenBraceToken);
        return cursor.finishNode(f.createMethodDeclaration(undefined, undefined, name, undefined, typeParameters, parameterList, returnType, body as TS.Block | undefined), pos);
    };

    /**
     * The `{ ... }` of a handler. Written out because the expression parser would read the `in` after it as an operator.
     * The `return` clause comes apart from the operations.
     */
    const parseHandlers = (cursor: TSPPSyntaxCursor) => {
        const f = cursor.factory;
        const pos = cursor.getNodePos();
        cursor.parseExpected(kinds.OpenBraceToken);
        const propertiesPos = cursor.getNodePos();
        const properties: TS.ObjectLiteralElementLike[] = [];
        let onReturn: TS.Expression | undefined;
        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            const entryPos = cursor.getNodePos();
            const entryStart = cursor.getTokenStart();
            if (!isName(cursor.tokenText())) {
                cursor.parseErrorAt(entryStart, entryStart + cursor.tokenText().length, "A handler holds a clause for each operation, named as the operation is.", syntaxErrorCode);
                break;
            }
            if ((cursor.tokenText() === "control" || cursor.tokenText() === "suspend") && isWordFollowedByName(cursor, cursor.tokenText())) {
                cursor.parseErrorAt(entryStart, entryStart + cursor.tokenText().length, `'${cursor.tokenText()}' clauses, which take the continuation, are not supported yet.`, syntaxErrorCode);
                cursor.nextToken();
            }
            const name = parseAnyName(cursor);
            const isReturn = ts.idText(name) === "return";
            let property: TS.ObjectLiteralElementLike;
            if (cursor.parseOptional(kinds.ColonToken)) property = cursor.finishNode(f.createPropertyAssignment(name, cursor.parseAssignmentExpression()), entryPos);
            else if (cursor.token() === kinds.OpenParenToken || cursor.token() === kinds.LessThanToken) property = parseHandlerMethod(cursor, entryPos, name);
            else property = cursor.finishNode(f.createShorthandPropertyAssignment(name), entryPos);
            if (isReturn) {
                if (onReturn) cursor.parseErrorAt(entryStart, name.end, "A handler may have one 'return' clause.", syntaxErrorCode);
                if (ts.isPropertyAssignment(property)) onReturn = property.initializer;
                else if (ts.isMethodDeclaration(property)) onReturn = cursor.finishNode(f.createFunctionExpression(undefined, undefined, undefined, property.typeParameters, property.parameters, property.type, property.body ?? f.createBlock([])), entryPos);
            }
            else properties.push(property);
            if (!cursor.parseOptional(kinds.CommaToken)) break;
        }
        const propertyList = range(f.createNodeArray(properties), propertiesPos, cursor.getNodePos());
        cursor.parseExpected(kinds.CloseBraceToken);
        const handlers = cursor.finishNode(f.createObjectLiteralExpression(propertyList, /*multiLine*/ true), pos);
        return { handlers, onReturn };
    };

    /**
     * A `handle` body lowers to a function, which `return`, `await`, and `yield` would not leave. The parser took the last two
     * in the context of the enclosing function, so the checker would not call them out.
     */
    const reportEscapes = (cursor: TSPPSyntaxCursor, node: TS.Node): void => {
        if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
        if (ts.isReturnStatement(node)) cursor.parseErrorAt(node.pos, node.end, "A 'handle' body cannot 'return': its last expression is its value.", syntaxErrorCode);
        else if (ts.isAwaitExpression(node) || ts.isForOfStatement(node) && node.awaitModifier) cursor.parseErrorAt(node.pos, node.end, "A 'handle' body cannot use 'await': move it to a function the body calls.", syntaxErrorCode);
        else if (ts.isYieldExpression(node)) cursor.parseErrorAt(node.pos, node.end, "A 'handle' body cannot use 'yield': move it to a function the body calls.", syntaxErrorCode);
        ts.forEachChild(node, child => reportEscapes(cursor, child));
    };

    /** The value of a statement list is its final expression statement, or that of each final branch. */
    const toCompletion = (cursor: TSPPSyntaxCursor, statements: readonly TS.Statement[]): TS.Statement[] => {
        const last = statements[statements.length - 1];
        return last ? [...statements.slice(0, -1), completeStatement(cursor, last)] : [];
    };

    const completeStatement = (cursor: TSPPSyntaxCursor, statement: TS.Statement): TS.Statement => {
        const f = cursor.factory;
        if (ts.isExpressionStatement(statement)) return range(f.createReturnStatement(statement.expression), statement.pos, statement.end);
        if (ts.isBlock(statement)) return range(f.createBlock(range(f.createNodeArray(toCompletion(cursor, statement.statements)), statement.statements.pos, statement.statements.end), /*multiLine*/ true), statement.pos, statement.end);
        if (ts.isIfStatement(statement)) return range(f.createIfStatement(statement.expression, completeStatement(cursor, statement.thenStatement), statement.elseStatement && completeStatement(cursor, statement.elseStatement)), statement.pos, statement.end);
        return statement;
    };

    /** The body after `in`: statements in braces, or the next `handle` of a chain. */
    const parseHandleBody = (cursor: TSPPSyntaxCursor): TS.Block => {
        const f = cursor.factory;
        const pos = cursor.getNodePos();
        if (isWordFollowedByName(cursor, "handle")) {
            const inner = parseHandle(cursor);
            const end = cursor.getNodePos();
            return range(f.createBlock(range(f.createNodeArray<TS.Statement>([range(f.createReturnStatement(inner), pos, end)]), pos, end), /*multiLine*/ true), pos, end);
        }
        cursor.parseExpected(kinds.OpenBraceToken);
        const statementsPos = cursor.getNodePos();
        const statements: TS.Statement[] = [];
        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            const before = cursor.getTokenStart();
            statements.push(cursor.parseStatement());
            if (cursor.getTokenStart() === before) cursor.nextToken();
        }
        statements.forEach(statement => reportEscapes(cursor, statement));
        const statementsEnd = cursor.getNodePos();
        cursor.parseExpected(kinds.CloseBraceToken);
        return range(f.createBlock(range(f.createNodeArray(toCompletion(cursor, statements)), statementsPos, statementsEnd), /*multiLine*/ true), pos, cursor.getNodePos());
    };

    const parseHandle = (cursor: TSPPSyntaxCursor): TS.Expression => {
        used = true;
        const f = cursor.factory;
        const pos = cursor.getNodePos();
        const start = cursor.getTokenStart();
        cursor.nextToken();
        const effect = cursor.parseType();
        const { handlers, onReturn } = parseHandlers(cursor);
        cursor.parseExpected(kinds.InKeyword);
        const block = parseHandleBody(cursor);
        const end = cursor.getNodePos();
        const parameter = markGenerated(ts, f.createParameterDeclaration(undefined, undefined, f.createIdentifier("__tspp_handler")), start);
        const body = range(f.createArrowFunction(undefined, undefined, range(f.createNodeArray([parameter]), pos, pos), undefined, createLoweredArrowToken(ts, f, pos), block), pos, end);
        const checked = range(f.createSatisfiesExpression(handlers, effect), handlers.pos, handlers.end);
        const callee = range(f.createParenthesizedExpression(body), pos, end);
        const call = range(f.createCallExpression(callee, undefined, range(f.createNodeArray<TS.Expression>([checked]), end, end)), pos, end);
        const handle: HandleSyntax = { call, effect, body, handlers };
        handles.set(call, handle);
        handleBodies.set(body, handle);
        if (!onReturn) return call;
        const returning = range(f.createParenthesizedExpression(onReturn), pos, end);
        return range(f.createCallExpression(returning, undefined, range(f.createNodeArray<TS.Expression>([call]), end, end)), pos, end);
    };

    const handleExpression: TSPPSyntaxExtension = {
        position: "expression",
        startTokens: [kinds.Identifier],
        keywords: ["handle"],
        isStart: cursor => isWordFollowedByName(cursor, "handle"),
        parse: parseHandle,
    };

    return {
        extensions: [effectDeclaration, clauseExtension, performExpression, handleExpression],
        // A rebuilt program binds its own copy of a declaration, which is where the items' names have to resolve.
        clauses: table(clauses as WeakMap<TS.Node, EffectClause>, (node, clause) => {
            if (!(node.flags & ts.NodeFlags.Synthesized)) ((clause as EffectClause & { readonly holder: { parent: TS.Node; }; }).holder).parent = node;
        }),
        effects: table(effects),
        performs: table(performs),
        performEffects: table(performEffects),
        handles: table(handles),
        handleBodies: table(handleBodies),
        used: () => used,
    };
}
