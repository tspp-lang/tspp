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
        languageService: {
            activate(context) {
                return context.languageService.registerQuickInfoProvider(request => {
                    const token = request.token;
                    if (!token) return undefined;
                    if (["let", "in", "do", "use", "def"].includes(token.text)) {
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(TS++ keyword) ${token.text}`,
                            documentation: modernKeywordDocumentation[token.text],
                        };
                    }
                    const statement = trailingClosureStatementAt(request.sourceText, token.start);
                    if (!statement) return undefined;
                    const match = /\buse\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^<;]+?))?\s*<-\s*([A-Za-z_$][\w$]*)/.exec(statement);
                    if (!match) return undefined;
                    const [, binding, annotation, callee] = match;
                    if (token.text === binding) {
                        const inferred = annotation?.trim()
                            ?? usefulType(request.semanticType)
                            ?? inferContinuationParameter(request.sourceText, callee);
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(const) ${binding}: ${inferred ?? "unknown"}`,
                            documentation: "A value supplied by the trailing continuation parameter.",
                        };
                    }
                    if (token.text === callee && !usefulDisplay(request.upstream?.display)) {
                        const declaration = functionDeclaration(request.sourceText, callee);
                        if (declaration) {
                            return { start: token.start, length: token.length, display: declaration };
                        }
                    }
                    return undefined;
                });
            },
        },
        editor: {
            keywords: ["let", "in", "do", "use", "def"],
            grammars: ["./editor/modern-syntax.tmLanguage.json"],
        },
    },
});

export default modernSyntaxPlugin;

const modernKeywordDocumentation: Readonly<Record<string, string>> = {
    let: "Introduces a lexical binding inside an expression.",
    in: "Separates expression-local bindings from their result expression.",
    do: "Starts a completion-valued block whose final expression is returned.",
    use: "Binds the value supplied to a trailing continuation.",
    def: "Declares a deeply readonly binding with const-context inference.",
};

function trailingClosureStatementAt(sourceText: string, position: number): string | undefined {
    const start = Math.max(sourceText.lastIndexOf(";", position - 1), sourceText.lastIndexOf("{", position - 1)) + 1;
    const end = sourceText.indexOf(";", position);
    if (end < 0) return undefined;
    const statement = sourceText.slice(start, end + 1);
    return /\buse\b/.test(statement) ? statement : undefined;
}

function usefulType(type: string | undefined): string | undefined {
    return type && type !== "any" && type !== "unknown" ? type : undefined;
}

function usefulDisplay(display: string | undefined): boolean {
    return !!display && !/\bany\b|\(Missing\)/.test(display);
}

function inferContinuationParameter(sourceText: string, functionName: string): string | undefined {
    const declaration = functionDeclarationSource(sourceText, functionName);
    if (!declaration) return undefined;
    const matches = [...declaration.matchAll(/\(\s*[A-Za-z_$][\w$]*\s*:\s*([^,)]+)\s*\)\s*=>/g)];
    return matches.length ? matches[matches.length - 1][1].trim() : undefined;
}

function functionDeclaration(sourceText: string, functionName: string): string | undefined {
    const declaration = functionDeclarationSource(sourceText, functionName);
    return declaration && `(function) ${declaration.replace(/\s+/g, " ").trim()}`;
}

function functionDeclarationSource(sourceText: string, functionName: string): string | undefined {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\bfunction\\s+${escaped}\\b`).exec(sourceText);
    if (!match) return undefined;
    const body = sourceText.indexOf("{", match.index);
    return body < 0 ? undefined : sourceText.slice(match.index, body).trim();
}
