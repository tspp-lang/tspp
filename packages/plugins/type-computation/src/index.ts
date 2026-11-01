import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type { TSPPTypeMatchArm, TSPPTypeSyntax } from "@tspp/plugin-sdk/compiler";

const pluginId = "type-computation";

export const typeComputationPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Type computation",
    },
    facets: {
        compiler: {
            activate(context) {
                const kinds = context.compiler.typeSyntaxKinds;
                const syntax: TSPPTypeSyntax = {
                    startTokens: [kinds.letKeyword, kinds.identifier, kinds.lessThanToken],
                    isStart: parser => {
                        if (parser.token() === kinds.letKeyword) {
                            return parser.lookAhead(() => {
                                parser.nextToken();
                                if (parser.token() !== kinds.identifier) return false;
                                parser.nextToken();
                                return parser.token() === kinds.equalsToken;
                            });
                        }
                        if (parser.token() === kinds.identifier) {
                            if (parser.tokenText() !== "match") return false;
                            return parser.lookAhead(() => {
                                parser.nextToken();
                                if (parser.hasPrecedingLineBreak()) return false;
                                parser.parseType();
                                return parser.token() === kinds.openBraceToken;
                            });
                        }
                        return parser.lookAhead(() => {
                            const parameters = parser.parseTypeParameters();
                            if (!parameters || parser.token() !== kinds.equalsGreaterThanToken) return false;
                            parser.nextToken();
                            return parser.token() === kinds.greaterThanToken;
                        });
                    },
                    parse: parser => {
                        const pos = parser.getNodePos();
                        if (parser.token() === kinds.letKeyword) {
                            parser.nextToken();
                            const name = parser.parseIdentifier();
                            parser.parseExpected(kinds.equalsToken);
                            const value = parser.parseType();
                            parser.parseExpected(kinds.inKeyword);
                            return parser.finishScopedTypeBinding(name, value, parser.parseType(), pos);
                        }
                        if (parser.token() === kinds.identifier) {
                            parser.nextToken();
                            const scrutinee = parser.parseType();
                            parser.parseExpected(kinds.openBraceToken);
                            const arms: TSPPTypeMatchArm[] = [];
                            while (
                                parser.token() !== kinds.closeBraceToken
                                && parser.token() !== kinds.endOfFileToken
                            ) {
                                const pattern = parser.parseTypeMatchPattern();
                                parser.parseExpected(kinds.colonToken);
                                arms.push({ pattern, result: parser.parseType() });
                                if (parser.token() === kinds.commaToken || parser.token() === kinds.semicolonToken) {
                                    parser.nextToken();
                                }
                                else break;
                            }
                            parser.parseExpected(kinds.closeBraceToken);
                            return parser.finishOrderedTypeMatch(scrutinee, arms, pos);
                        }
                        const parameters = parser.parseTypeParameters();
                        if (!parameters) throw new Error("Type constructor parameters were not parsed.");
                        parser.parseExpected(kinds.equalsGreaterThanToken);
                        parser.parseExpected(kinds.greaterThanToken);
                        return parser.finishTypeConstructor(parameters, parser.parseType(), pos);
                    },
                };
                return context.compiler.registerTypeSyntax(syntax);
            },
        },
        editor: {
            keywords: ["let", "in", "match", "infer"],
            grammars: ["./editor/type-computation.tmLanguage.json"],
        },
    },
});

export default typeComputationPlugin;
