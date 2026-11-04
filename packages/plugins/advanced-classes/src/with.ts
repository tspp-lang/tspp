import { markGenerated } from "@tspp/plugin-sdk";
import type {
    TSPPSyntaxCursor,
    TSPPSyntaxExtension,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

export function createWithSyntax(ts: TSPPTypeScript): {
    extension: TSPPSyntaxExtension;
    withExpressions: WeakSet<TS.Node>;
} {
    const kinds = ts.SyntaxKind;
    const withExpressions = new WeakSet<TS.Node>();

    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T =>
        ts.setTextRange(node, { pos, end });

    // `with(target, patch)` or `with(target) { patch }`
    function isWithStart(cursor: TSPPSyntaxCursor): boolean {
        if (cursor.token() !== kinds.WithKeyword) return false;
        return cursor.lookAhead(() => {
            cursor.nextToken();
            return cursor.token() === kinds.OpenParenToken;
        });
    }

    function parseWith(cursor: TSPPSyntaxCursor): TS.Expression {
        const startPos = cursor.getTokenStart();
        const f = cursor.factory;

        cursor.nextToken(); // consume 'with'
        cursor.parseExpected(kinds.OpenParenToken);
        const target = cursor.parseAssignmentExpression();

        let patch: TS.Expression;
        if (cursor.token() === kinds.CommaToken) {
            cursor.nextToken(); // consume ','
            patch = cursor.parseAssignmentExpression();
            cursor.parseExpected(kinds.CloseParenToken);
        } else {
            cursor.parseExpected(kinds.CloseParenToken);
            // with(target) { ... }
            patch = cursor.parseAssignmentExpression();
        }

        const after = cursor.getTokenStart();

        // Lowers to: target.copy(patch)
        const targetExpr = ts.isIdentifier(target) ? target : f.createParenthesizedExpression(target);
        const copyAccess = range(
            f.createPropertyAccessExpression(
                targetExpr,
                f.createIdentifier("copy"),
            ),
            startPos,
            after,
        );
        const callCopy = range(
            f.createCallExpression(copyAccess, undefined, f.createNodeArray([patch])),
            startPos,
            after,
        );

        let currentExpr: TS.Expression = callCopy;
        while (true) {
            if (cursor.token() === kinds.DotToken) {
                cursor.nextToken();
                const prop = cursor.parseIdentifier();
                currentExpr = range(
                    f.createPropertyAccessExpression(currentExpr, prop),
                    startPos,
                    cursor.getNodePos(),
                );
            } else if (cursor.token() === kinds.OpenBracketToken) {
                cursor.nextToken();
                const elem = cursor.parseAssignmentExpression();
                cursor.parseExpected(kinds.CloseBracketToken);
                currentExpr = range(
                    f.createElementAccessExpression(currentExpr, elem),
                    startPos,
                    cursor.getNodePos(),
                );
            } else if (cursor.token() === kinds.OpenParenToken) {
                cursor.nextToken();
                const args: TS.Expression[] = [];
                while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
                    args.push(cursor.parseAssignmentExpression());
                    if (cursor.token() === kinds.CommaToken) cursor.nextToken();
                    else break;
                }
                cursor.parseExpected(kinds.CloseParenToken);
                currentExpr = range(
                    f.createCallExpression(currentExpr, undefined, f.createNodeArray(args)),
                    startPos,
                    cursor.getNodePos(),
                );
            } else {
                break;
            }
        }

        withExpressions.add(callCopy);
        return markGenerated(ts, currentExpr, startPos);
    }

    const extension: TSPPSyntaxExtension = {
        position: "expression",
        startTokens: [kinds.WithKeyword],
        keywords: ["with"],
        isStart: isWithStart,
        parse: parseWith,
    };

    return {
        extension,
        withExpressions,
    };
}
