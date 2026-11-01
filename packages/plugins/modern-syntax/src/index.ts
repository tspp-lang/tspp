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
        syntax: {
            keywords: [
                { keyword: "let", position: "expression" },
                { keyword: "do", position: "expression" },
                { keyword: "do", position: "function-clause" },
                { keyword: "use", position: "statement" },
                { keyword: "def", position: "statement" },
            ],
        },
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
                        // `let x in body` would parse as a declaration list, but the body could only read `undefined`.
                        checker.checkVariableDeclarationList(parts.declarations, { requireInitializers: true });
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

/** The type of the first parameter of the callee's last (continuation) parameter, read from its signature text. */
function inferContinuationParameter(sourceText: string, functionName: string): string | undefined {
    const declaration = functionDeclarationSource(sourceText, functionName);
    let open = -1;
    if (declaration) scanDepth(declaration, (character, index, depth) => {
        if (character === "(" && depth === 0) { open = index; return true; }
    });
    const parameters = declaration && parenthesizedContents(declaration, open);
    if (parameters === undefined) return undefined;
    const continuation = annotationOf(splitTopLevel(parameters, ",").pop() ?? "");
    if (!continuation?.startsWith("(")) return undefined;
    const continuationParameters = parenthesizedContents(continuation, 0);
    return continuationParameters === undefined ? undefined : annotationOf(splitTopLevel(continuationParameters, ",")[0] ?? "");
}

const openers = "([{<";
const closers = ")]}>";

/** Visits each character with the bracket depth before it; `=>` never counts as a closing `>`. */
function scanDepth(text: string, visit: (character: string, index: number, depth: number) => boolean | void): void {
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === ">" && text[index - 1] === "=") continue;
        if (closers.includes(character)) depth--;
        if (visit(character, index, depth)) return;
        if (openers.includes(character)) depth++;
    }
}

function parenthesizedContents(text: string, open: number): string | undefined {
    if (text[open] !== "(") return undefined;
    let close = -1;
    scanDepth(text.slice(open), (character, index, depth) => {
        if (character === ")" && depth === 0) { close = open + index; return true; }
    });
    return close < 0 ? undefined : text.slice(open + 1, close);
}

function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let start = 0;
    scanDepth(text, (character, index, depth) => {
        if (character === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
    });
    const last = text.slice(start);
    return last.trim() ? [...parts, last] : parts;
}

/** The type annotation of one `name: Type` parameter, if it has one. */
function annotationOf(parameter: string): string | undefined {
    let colon = -1;
    scanDepth(parameter, (character, index, depth) => {
        if (character === ":" && depth === 0) { colon = index; return true; }
    });
    return colon < 0 ? undefined : parameter.slice(colon + 1).trim() || undefined;
}

function functionDeclaration(sourceText: string, functionName: string): string | undefined {
    const declaration = functionDeclarationSource(sourceText, functionName);
    return declaration && `(function) ${declaration.replace(/\s+/g, " ").trim()}`;
}

function functionDeclarationSource(sourceText: string, functionName: string): string | undefined {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\bfunction\\s+${escaped}\\b`).exec(sourceText);
    if (!match) return undefined;
    // The signature ends at the body or, for an ambient declaration, at its semicolon.
    let end = -1;
    scanDepth(sourceText.slice(match.index), (character, index, depth) => {
        if (depth === 0 && (character === "{" || character === ";")) { end = match.index + index; return true; }
    });
    return end < 0 ? undefined : sourceText.slice(match.index, end).trim();
}
