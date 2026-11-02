import type {
    TSPPDiagnosticProvider,
    TSPPSyntaxCursor,
    TSPPSyntaxExtension,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

const misplacedUseMessage = "A trailing-closure binding is only allowed directly inside a completion-valued block.";

/**
 * Modern syntax lowers to ordinary TypeScript while it is parsed, so the compiler checks and emits the result as
 * written by hand:
 *
 * - `let a = 1, b = 2 in a + b` becomes `(() => { let a = 1, b = 2; return a + b; })()`.
 * - `do { ...; value; }` becomes `(() => { ...; return value; })()`; the final expression statement of the block, and
 *   of each branch of a final `if`, is returned.
 * - A `do { ... }` function body returns its completion value the same way.
 * - `use x <- f(args);` directly inside a completion block passes the rest of the block to `f` as a trailing closure:
 *   `return f(args, (x) => { ...rest });`.
 * - `def x = { ... };` becomes `const x = { ... } as const;` when the initializer can take a const assertion.
 */
export function createModernSyntax(ts: TSPPTypeScript): { extensions: TSPPSyntaxExtension[]; diagnostics: TSPPDiagnosticProvider; } {
    const kinds = ts.SyntaxKind;
    /** Statements that stand in for a misplaced `use`, with the end of the `use` itself; reported as diagnostics. */
    const misplacedUses = new WeakMap<TS.Node, number>();
    let misplacedUseCount = 0;

    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T => ts.setTextRange(node, { pos, end });

    /** `(() => { statements })()`, every node covering the source range of the construct it lowers. */
    function immediatelyInvoked(cursor: TSPPSyntaxCursor, body: TS.Block, pos: number, end: number): TS.CallExpression {
        const f = cursor.factory;
        const arrow = range(f.createArrowFunction(
            /*modifiers*/ undefined,
            /*typeParameters*/ undefined,
            range(f.createNodeArray<TS.ParameterDeclaration>([]), pos, pos),
            /*type*/ undefined,
            range(f.createToken(kinds.EqualsGreaterThanToken), pos, pos),
            body,
        ), pos, end);
        const callee = range(f.createParenthesizedExpression(arrow), pos, end);
        return range(f.createCallExpression(callee, /*typeArguments*/ undefined, range(f.createNodeArray<TS.Expression>([]), end, end)), pos, end);
    }

    /** Returns the completion value of a statement list: its final expression statement, or each final branch. */
    function toCompletion(cursor: TSPPSyntaxCursor, statements: readonly TS.Statement[]): TS.Statement[] {
        const last = statements[statements.length - 1];
        const completed = last && completeStatement(cursor, last);
        return completed && completed !== last ? [...statements.slice(0, -1), completed] : [...statements];
    }

    function completeStatement(cursor: TSPPSyntaxCursor, statement: TS.Statement): TS.Statement {
        const f = cursor.factory;
        if (ts.isExpressionStatement(statement)) return range(f.createReturnStatement(statement.expression), statement.pos, statement.end);
        if (ts.isBlock(statement)) return range(f.createBlock(range(f.createNodeArray(toCompletion(cursor, statement.statements)), statement.statements.pos, statement.statements.end), /*multiLine*/ true), statement.pos, statement.end);
        if (ts.isIfStatement(statement)) {
            return range(f.createIfStatement(
                statement.expression,
                completeStatement(cursor, statement.thenStatement),
                statement.elseStatement && completeStatement(cursor, statement.elseStatement),
            ), statement.pos, statement.end);
        }
        return statement;
    }

    function isUseStart(cursor: TSPPSyntaxCursor): boolean {
        if (cursor.token() !== kinds.Identifier || cursor.tokenText() !== "use") return false;
        return cursor.lookAhead(() => {
            cursor.nextToken();
            if (cursor.hasPrecedingLineBreak()) return false;
            if (cursor.token() !== kinds.Identifier && cursor.token() !== kinds.OpenBracketToken && cursor.token() !== kinds.OpenBraceToken) return false;
            let depth = 0;
            while (cursor.token() !== kinds.EndOfFileToken) {
                switch (cursor.token()) {
                    case kinds.OpenBracketToken:
                    case kinds.OpenBraceToken:
                    case kinds.OpenParenToken:
                        depth++;
                        break;
                    case kinds.CloseBracketToken:
                    case kinds.CloseBraceToken:
                    case kinds.CloseParenToken:
                        depth--;
                        break;
                    case kinds.LessThanToken:
                        if (depth === 0) {
                            cursor.nextToken();
                            return cursor.token() === kinds.MinusToken;
                        }
                        break;
                    case kinds.SemicolonToken:
                        if (depth === 0) return false;
                        break;
                }
                if (depth === 0 && cursor.hasPrecedingLineBreak()) return false;
                cursor.nextToken();
            }
            return false;
        });
    }

    /** `use name: Type <- target;` up to and including its semicolon. */
    function parseUseHead(cursor: TSPPSyntaxCursor) {
        const pos = cursor.getNodePos();
        cursor.nextToken();
        const name = cursor.parseBindingName();
        const type = cursor.parseTypeAnnotation();
        cursor.parseExpected(kinds.LessThanToken);
        cursor.parseExpected(kinds.MinusToken);
        const target = cursor.parseExpression();
        cursor.parseSemicolon();
        return { pos, name, type, target, end: cursor.getNodePos() };
    }

    /** `target(args, (name) => { rest })`, for a `use` binding followed by `rest`. */
    function createTrailingClosureCall(cursor: TSPPSyntaxCursor, head: ReturnType<typeof parseUseHead>, rest: TS.Statement[]): TS.CallExpression {
        const f = cursor.factory;
        const end = cursor.getNodePos();
        const parameter = range(
            f.createParameterDeclaration(/*modifiers*/ undefined, /*dotDotDotToken*/ undefined, head.name, /*questionToken*/ undefined, head.type),
            // Starting where the closure starts lets the printer omit parentheses around a lone identifier.
            head.pos,
            head.type?.end ?? head.name.end,
        );
        const body = range(f.createBlock(range(f.createNodeArray(rest), head.end, end), /*multiLine*/ true), head.end, end);
        const closure = range(f.createArrowFunction(
            /*modifiers*/ undefined,
            /*typeParameters*/ undefined,
            range(f.createNodeArray([parameter]), parameter.pos, parameter.end),
            /*type*/ undefined,
            range(f.createToken(kinds.EqualsGreaterThanToken), parameter.end, parameter.end),
            body,
        ), head.pos, end);
        const target = head.target;
        return ts.isCallExpression(target)
            ? range(f.createCallExpression(target.expression, target.typeArguments, range(f.createNodeArray([...target.arguments, closure]), target.arguments.pos, end)), target.pos, end)
            : range(f.createCallExpression(target, /*typeArguments*/ undefined, range(f.createNodeArray([closure]), target.end, end)), target.pos, end);
    }

    /** The statements of a completion block up to its closing brace, with `use` bindings nested into closures. */
    function parseCompletionStatements(cursor: TSPPSyntaxCursor): TS.Statement[] {
        const f = cursor.factory;
        const statements: TS.Statement[] = [];
        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            if (!isUseStart(cursor)) {
                statements.push(cursor.parseStatement());
                continue;
            }
            const head = parseUseHead(cursor);
            const rest = parseCompletionStatements(cursor);
            const call = createTrailingClosureCall(cursor, head, rest);
            statements.push(range(f.createReturnStatement(call), head.pos, call.end));
            return statements;
        }
        return toCompletion(cursor, statements);
    }

    function parseCompletionBlock(cursor: TSPPSyntaxCursor): TS.Block {
        const pos = cursor.getNodePos();
        cursor.parseExpected(kinds.OpenBraceToken);
        const statementsPos = cursor.getNodePos();
        const statements = parseCompletionStatements(cursor);
        const statementsEnd = cursor.getNodePos();
        cursor.parseExpected(kinds.CloseBraceToken);
        return cursor.finishNode(cursor.factory.createBlock(range(cursor.factory.createNodeArray(statements), statementsPos, statementsEnd), /*multiLine*/ true), pos);
    }

    /** `do {` that is not the start of a `do ... while` loop. */
    function isDoExpressionStart(cursor: TSPPSyntaxCursor): boolean {
        return cursor.lookAhead(() => {
            cursor.nextToken();
            if (cursor.token() !== kinds.OpenBraceToken) return false;
            let depth = 1;
            cursor.nextToken();
            while (cursor.token() !== kinds.EndOfFileToken && depth > 0) {
                if (cursor.token() === kinds.OpenBraceToken) depth++;
                else if (cursor.token() === kinds.CloseBraceToken) depth--;
                cursor.nextToken();
            }
            return cursor.token() !== kinds.WhileKeyword;
        });
    }

    /** `let` followed by bindings and an `in` before the end of the line or statement. */
    function isLetInStart(cursor: TSPPSyntaxCursor): boolean {
        return cursor.lookAhead(() => {
            cursor.nextToken();
            if (cursor.token() !== kinds.Identifier && cursor.token() !== kinds.OpenBracketToken && cursor.token() !== kinds.OpenBraceToken) return false;
            let depth = 0;
            while (cursor.token() !== kinds.EndOfFileToken) {
                switch (cursor.token()) {
                    case kinds.OpenBracketToken:
                    case kinds.OpenBraceToken:
                    case kinds.OpenParenToken:
                        depth++;
                        break;
                    case kinds.CloseBracketToken:
                    case kinds.CloseBraceToken:
                    case kinds.CloseParenToken:
                        depth--;
                        break;
                    case kinds.InKeyword:
                        if (depth === 0) return true;
                        break;
                    case kinds.SemicolonToken:
                        if (depth === 0) return false;
                        break;
                }
                if (depth === 0 && cursor.hasPrecedingLineBreak()) return false;
                cursor.nextToken();
            }
            return false;
        });
    }

    const expression: TSPPSyntaxExtension = {
        position: "expression",
        startTokens: [kinds.LetKeyword, kinds.DoKeyword],
        isStart: cursor => cursor.token() === kinds.DoKeyword ? isDoExpressionStart(cursor) : isLetInStart(cursor),
        parse: cursor => {
            const f = cursor.factory;
            const pos = cursor.getNodePos();
            if (cursor.token() === kinds.DoKeyword) {
                cursor.nextToken();
                const block = parseCompletionBlock(cursor);
                return immediatelyInvoked(cursor, block, pos, cursor.getNodePos());
            }
            const declarations = cursor.parseVariableDeclarationList(/*inForStatementInitializer*/ true);
            for (const declaration of declarations.declarations) {
                // `let x in body` would parse as a declaration list, but the body could only read `undefined`.
                if (!declaration.initializer) cursor.parseErrorAt(declaration.pos, declaration.end, "'let' declarations must be initialized.");
            }
            cursor.parseExpected(kinds.InKeyword);
            const result = cursor.parseAssignmentExpression();
            const end = cursor.getNodePos();
            const statements = [
                range(f.createVariableStatement(/*modifiers*/ undefined, declarations), declarations.pos, declarations.end),
                range(f.createReturnStatement(result), result.pos, result.end),
            ];
            const body = range(f.createBlock(range(f.createNodeArray(statements), pos, end), /*multiLine*/ true), pos, end);
            return immediatelyInvoked(cursor, body, pos, end);
        },
    };

    const functionBody: TSPPSyntaxExtension = {
        position: "function-body",
        startTokens: [kinds.DoKeyword],
        isStart: cursor => cursor.lookAhead(() => cursor.nextToken() === kinds.OpenBraceToken),
        parse: cursor => cursor.runInFunctionBody(() => {
            const pos = cursor.getNodePos();
            cursor.nextToken();
            const block = parseCompletionBlock(cursor);
            return range(block, pos, block.end);
        }),
    };

    /** A `use` the completion-block parser did not reach: it is not directly inside a completion block. */
    const misplacedUse: TSPPSyntaxExtension = {
        position: "statement",
        startTokens: [kinds.Identifier],
        isStart: isUseStart,
        parse: cursor => {
            // Lowered as it would be in a completion block, minus the return, so the rest still sees the binding.
            const head = parseUseHead(cursor);
            const rest: TS.Statement[] = [];
            while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) rest.push(cursor.parseStatement());
            const call = createTrailingClosureCall(cursor, head, rest);
            const statement = range(cursor.factory.createExpressionStatement(call), head.pos, call.end);
            misplacedUses.set(statement, head.end);
            misplacedUseCount++;
            return statement;
        },
    };

    const deepReadonlyBinding: TSPPSyntaxExtension = {
        position: "statement",
        startTokens: [kinds.Identifier],
        isStart: cursor => cursor.tokenText() === "def" && cursor.lookAhead(() => {
            cursor.nextToken();
            return !cursor.hasPrecedingLineBreak()
                && (cursor.token() === kinds.Identifier || cursor.token() === kinds.OpenBracketToken || cursor.token() === kinds.OpenBraceToken);
        }),
        parse: cursor => {
            const f = cursor.factory;
            const pos = cursor.getNodePos();
            const listPos = cursor.getNodePos();
            cursor.nextToken();
            const declarations: TS.VariableDeclaration[] = [];
            do {
                const declarationPos = cursor.getNodePos();
                const name = cursor.parseBindingName();
                const type = cursor.parseTypeAnnotation();
                let initializer: TS.Expression | undefined;
                if (cursor.parseOptional(kinds.EqualsToken)) {
                    initializer = cursor.parseAssignmentExpression();
                    if (canTakeConstAssertion(initializer)) {
                        const constType = range(f.createTypeReferenceNode(range(f.createIdentifier("const"), initializer.end, initializer.end)), initializer.end, initializer.end);
                        initializer = range(f.createAsExpression(initializer, constType), initializer.pos, initializer.end);
                    }
                }
                declarations.push(cursor.finishNode(f.createVariableDeclaration(name, /*exclamationToken*/ undefined, type, initializer), declarationPos));
            }
            while (cursor.parseOptional(kinds.CommaToken));
            const list = cursor.finishNode(f.createVariableDeclarationList(declarations, ts.NodeFlags.Const), listPos);
            cursor.parseSemicolon();
            return cursor.finishNode(f.createVariableStatement(/*modifiers*/ undefined, list), pos);
        },
    };

    /** Expressions TypeScript accepts in `as const`; `def` gives the others an ordinary const binding. */
    function canTakeConstAssertion(node: TS.Expression): boolean {
        switch (node.kind) {
            case kinds.StringLiteral:
            case kinds.NoSubstitutionTemplateLiteral:
            case kinds.NumericLiteral:
            case kinds.BigIntLiteral:
            case kinds.TrueKeyword:
            case kinds.FalseKeyword:
            case kinds.ArrayLiteralExpression:
            case kinds.ObjectLiteralExpression:
            case kinds.TemplateExpression:
                return true;
            case kinds.ParenthesizedExpression:
                return canTakeConstAssertion((node as TS.ParenthesizedExpression).expression);
            case kinds.PrefixUnaryExpression:
                return (node as TS.PrefixUnaryExpression).operator === kinds.MinusToken
                    && ts.isNumericLiteral((node as TS.PrefixUnaryExpression).operand);
            default:
                return false;
        }
    }

    const diagnostics: TSPPDiagnosticProvider = {
        id: "misplaced-use",
        getSemanticDiagnostics: sourceFile => {
            if (!misplacedUseCount) return [];
            const found: TS.Diagnostic[] = [];
            const visit = (node: TS.Node): void => {
                const end = misplacedUses.get(node);
                if (end !== undefined) {
                    const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, sourceFile.text, /*onError*/ undefined, node.pos);
                    scanner.scan();
                    const start = scanner.getTokenStart();
                    found.push({ category: ts.DiagnosticCategory.Error, code: 18071, file: sourceFile, start, length: end - start, messageText: misplacedUseMessage });
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            return found;
        },
    };

    return { extensions: [expression, functionBody, misplacedUse, deepReadonlyBinding], diagnostics };
}
