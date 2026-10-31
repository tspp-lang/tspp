import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import {
    type TSPPBlock,
    type TSPPDeepReadonlyBindingSyntax,
    type TSPPExpression,
    type TSPPExpressionSyntax,
    type TSPPExtensionExpression,
    type TSPPFunctionBodySyntax,
    type TSPPTrailingClosureBindingSyntax,
    type TSPPVariableDeclarationList,
} from "@tspp/plugin-sdk/compiler";

const pluginId = "modern-syntax";

type ModernExpressionParts =
    | { kind: "let-in"; declarations: TSPPVariableDeclarationList; body: TSPPExpression; }
    | { kind: "do"; block: TSPPBlock; };

function getParts(node: TSPPExtensionExpression): ModernExpressionParts {
    if (node.pluginId !== pluginId) throw new Error(`Invalid extension expression for '${pluginId}'.`);
    if (node.extensionChildren.length === 2) {
        return { kind: "let-in", declarations: node.extensionChildren[0], body: node.extensionChildren[1] };
    }
    if (node.extensionChildren.length === 1) return { kind: "do", block: node.extensionChildren[0] };
    throw new Error(`Invalid extension expression for '${pluginId}'.`);
}

export const modernSyntaxPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Modern syntax",
    },
    facets: {
        compiler: {
            activate(context) {
                const kinds = context.compiler.expressionSyntaxKinds;
                const expressionSyntax: TSPPExpressionSyntax = {
                    startTokens: [kinds.letKeyword, kinds.doKeyword],
                    isStart: parser => {
                        if (parser.token() === kinds.doKeyword) {
                            return parser.lookAhead(() => {
                                parser.nextToken();
                                if (parser.token() !== kinds.openBraceToken) return false;
                                let depth = 1;
                                parser.nextToken();
                                while (parser.token() !== kinds.endOfFileToken && depth > 0) {
                                    if (parser.token() === kinds.openBraceToken) depth++;
                                    else if (parser.token() === kinds.closeBraceToken) depth--;
                                    parser.nextToken();
                                }
                                return parser.token() !== kinds.whileKeyword;
                            });
                        }
                        return parser.lookAhead(() => {
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
                        });
                    },
                    parse: parser => {
                        const pos = parser.getNodePos();
                        if (parser.token() === kinds.doKeyword) {
                            parser.parseExpected(kinds.doKeyword);
                            return parser.finishExpression([parser.parseBlock()], pos);
                        }
                        const declarations = parser.parseVariableDeclarationList(/*inForStatementInitializer*/ true);
                        parser.parseExpected(kinds.inKeyword);
                        const body = parser.parseAssignmentExpression();
                        return parser.finishExpression([declarations, body], pos);
                    },
                    check: (node, checker, checkMode) => {
                        const parts = getParts(node);
                        if (parts.kind === "do") return checker.checkCompletionBlock(parts.block, checkMode);
                        checker.checkVariableDeclarationList(parts.declarations);
                        return checker.checkExpression(parts.body, checkMode);
                    },
                    transform: (node, transformer) => {
                        const parts = getParts(node);
                        if (parts.kind === "do") return transformer.createCompletionBlockIIFE(parts.block);
                        const declarations = transformer.visitVariableDeclarationList(parts.declarations);
                        const body = transformer.visitExpression(parts.body);
                        const block = transformer.createBlock([
                            transformer.createVariableStatement(declarations),
                            transformer.createReturnStatement(body),
                        ], /*multiLine*/ true);
                        return transformer.createCallExpression(
                            transformer.createParenthesizedExpression(transformer.createArrowFunction(block)),
                        );
                    },
                };
                const functionBodySyntax: TSPPFunctionBodySyntax = {
                    startTokens: [kinds.doKeyword],
                    completion: "implicit-return",
                    isStart: parser => {
                        if (parser.token() !== kinds.doKeyword) return false;
                        return parser.lookAhead(() => {
                            parser.nextToken();
                            return parser.token() === kinds.openBraceToken;
                        });
                    },
                    parse: parser => {
                        parser.parseExpected(kinds.doKeyword);
                        return parser.parseBlock();
                    },
                };
                const trailingClosureBindingSyntax: TSPPTrailingClosureBindingSyntax = {
                    startTokens: [kinds.identifier],
                    isStart: parser => {
                        if (parser.tokenText() !== "use") return false;
                        return parser.lookAhead(() => {
                            parser.nextToken();
                            if (parser.hasPrecedingLineBreak()) return false;
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
                                    case kinds.lessThanToken:
                                        if (depth === 0) {
                                            parser.nextToken();
                                            return parser.token() === kinds.minusToken;
                                        }
                                        break;
                                    case kinds.semicolonToken:
                                        if (depth === 0) return false;
                                        break;
                                }
                                if (depth === 0 && parser.hasPrecedingLineBreak()) return false;
                                parser.nextToken();
                            }
                            return false;
                        });
                    },
                    parse: parser => {
                        const pos = parser.getNodePos();
                        parser.nextToken();
                        const name = parser.parseBindingName();
                        const type = parser.parseTypeAnnotation();
                        parser.parseExpected(kinds.lessThanToken);
                        parser.parseExpected(kinds.minusToken);
                        const target = parser.parseExpression();
                        parser.parseSemicolon();
                        return parser.finishTrailingClosureBinding(name, type, target, pos);
                    },
                };
                const deepReadonlyBindingSyntax: TSPPDeepReadonlyBindingSyntax = {
                    startTokens: [kinds.identifier],
                    isStart: parser => {
                        if (parser.tokenText() !== "def") return false;
                        return parser.lookAhead(() => {
                            parser.nextToken();
                            return !parser.hasPrecedingLineBreak()
                                && (
                                    parser.token() === kinds.identifier
                                    || parser.token() === kinds.openBracketToken
                                    || parser.token() === kinds.openBraceToken
                                );
                        });
                    },
                    parse: parser => {
                        const pos = parser.getNodePos();
                        parser.nextToken();
                        return parser.finishDeepReadonlyBinding(pos);
                    },
                };
                context.onDispose(context.compiler.registerFunctionBodySyntax(functionBodySyntax));
                context.onDispose(context.compiler.registerTrailingClosureBindingSyntax(trailingClosureBindingSyntax));
                context.onDispose(context.compiler.registerDeepReadonlyBindingSyntax(deepReadonlyBindingSyntax));
                return context.compiler.registerExpressionSyntax(expressionSyntax);
            },
        },
        editor: {
            grammars: ["./editor/modern-syntax.tmLanguage.json"],
        },
    },
});

export default modernSyntaxPlugin;
