import {
    definePlugin,
    TSPP_PLUGIN_API_VERSION,
    type TSPPExpression,
    type TSPPExpressionSyntax,
    type TSPPExtensionExpression,
    type TSPPVariableDeclarationList,
} from "@tspp/plugin-sdk";

const pluginId = "modern-syntax/let-in";

function getParts(node: TSPPExtensionExpression): {
    declarations: TSPPVariableDeclarationList;
    body: TSPPExpression;
} {
    if (node.pluginId !== pluginId || node.extensionChildren.length !== 2) {
        throw new Error(`Invalid extension expression for '${pluginId}'.`);
    }
    return {
        declarations: node.extensionChildren[0],
        body: node.extensionChildren[1],
    };
}

export const letInExpressionPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.1",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Let-in expressions",
    },

    activate(context) {
        const kinds = context.compiler.expressionSyntaxKinds;
        const syntax: TSPPExpressionSyntax = {
            startTokens: [kinds.letKeyword],

            isStart: parser => parser.lookAhead(() => {
                parser.nextToken();
                if (
                    parser.token() !== kinds.identifier
                    && parser.token() !== kinds.openBracketToken
                    && parser.token() !== kinds.openBraceToken
                ) return false;

                let depth = 0;
                while (parser.token() !== kinds.endOfFileToken) {
                    switch (parser.token()) {
                        case kinds.openBracketToken:
                        case kinds.openBraceToken:
                        case kinds.openParenToken:
                            depth++;
                            break;
                        case kinds.closeBracketToken:
                        case kinds.closeBraceToken:
                        case kinds.closeParenToken:
                            depth--;
                            break;
                        case kinds.inKeyword:
                            if (depth === 0) return true;
                            break;
                        case kinds.semicolonToken:
                            if (depth === 0) return false;
                            break;
                    }
                    if (depth === 0 && parser.hasPrecedingLineBreak()) return false;
                    parser.nextToken();
                }
                return false;
            }),

            parse: parser => {
                const pos = parser.getNodePos();
                const declarations = parser.parseVariableDeclarationList(/*inForStatementInitializer*/ true);
                parser.parseExpected(kinds.inKeyword);
                const body = parser.parseAssignmentExpression();
                return parser.finishExpression([declarations, body], pos);
            },

            check: (node, checker, checkMode) => {
                const { declarations, body } = getParts(node);
                checker.checkVariableDeclarationList(declarations);
                return checker.checkExpression(body, checkMode);
            },

            transform: (node, transformer) => {
                const { declarations, body } = getParts(node);
                const visitedDeclarations = transformer.visitVariableDeclarationList(declarations);
                const visitedBody = transformer.visitExpression(body);
                const block = transformer.createBlock([
                    transformer.createVariableStatement(visitedDeclarations),
                    transformer.createReturnStatement(visitedBody),
                ], /*multiLine*/ true);
                const arrow = transformer.createArrowFunction(block);
                return transformer.createCallExpression(transformer.createParenthesizedExpression(arrow));
            },
        };

        return context.compiler.registerExpressionSyntax(syntax);
    },
});

export default letInExpressionPlugin;
