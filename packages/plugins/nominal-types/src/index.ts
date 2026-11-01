import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type { TSPPDeclarationSyntax } from "@tspp/plugin-sdk/compiler";
import { createDataDeclarationSyntax } from "./data";
import { createValueMatchSyntax } from "./match";

const pluginId = "nominal-types";

export const nominalTypesPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.1",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Nominal types",
    },
    facets: {
        compiler: {
            activate(context) {
                const kinds = context.compiler.declarationSyntaxKinds;
                const syntax: TSPPDeclarationSyntax = {
                    startTokens: [kinds.identifier],
                    binding: "type-and-value",
                    runtime: "erased",
                    valueUse: "call-only",
                    isStart: parser => parser.tokenText() === "newtype" && parser.lookAhead(() => {
                        parser.nextToken();
                        return !parser.hasPrecedingLineBreak() && /^[A-Za-z_$][\w$]*$/.test(parser.tokenText());
                    }),
                    parse: parser => {
                        const pos = parser.getNodePos();
                        parser.nextToken();
                        const name = parser.parseIdentifier();
                        const typeParameters = parser.parseTypeParameters();
                        parser.parseExpected(kinds.equalsToken);
                        const type = parser.parseType();
                        parser.parseSemicolon();
                        return parser.finishTypeAliasDeclaration(name, typeParameters, type, pos);
                    },
                    getDeclaredType: (node, checker, underlyingType) => checker.createNominalType(node, underlyingType),
                    getValueType: (node, checker) => checker.createIdentityConstructorType(
                        node,
                        checker.getTypeFromTypeNode(checker.getTypeNode(node)),
                        checker.getDeclaredType(node),
                    ),
                    transform: (node, transformer) => transformer.createNotEmittedStatement(node),
                    transformCall: (node, _declaration, transformer) => {
                        const args = transformer.getArguments(node);
                        return args.length === 1 ? transformer.visitExpression(args[0]) : node;
                    },
                    emitDeclaration: (node, emitter) => emitter.emitTypeAliasDeclaration(node, "newtype"),
                    emitCompatibilityDeclaration: (node, emitter) => emitter.emitCompatibilityNominalDeclaration(node),
                };
                const disposeNewtype = context.compiler.registerDeclarationSyntax(syntax);
                const disposeData = context.compiler.registerDeclarationSyntax(createDataDeclarationSyntax(kinds));
                const disposeMatch = context.compiler.registerExpressionSyntax(
                    createValueMatchSyntax(context.compiler.expressionSyntaxKinds),
                );
                return () => {
                    disposeMatch();
                    disposeData();
                    disposeNewtype();
                };
            },
        },
        editor: {
            keywords: ["newtype", "data", "match"],
            grammars: ["./editor/nominal-types.tmLanguage.json"],
        },
    },
});

export default nominalTypesPlugin;
