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

        const endPos = cursor.getNodePos();

        // Lowers to: target.copy(patch)
        const targetExpr = ts.isIdentifier(target) ? target : f.createParenthesizedExpression(target);
        const copyAccess = range(
            f.createPropertyAccessExpression(
                targetExpr,
                f.createIdentifier("copy"),
            ),
            startPos,
            endPos,
        );
        const callCopy = range(
            f.createCallExpression(copyAccess, undefined, f.createNodeArray([patch])),
            startPos,
            endPos,
        );

        withExpressions.add(callCopy);
        return markGenerated(ts, callCopy, startPos);
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
