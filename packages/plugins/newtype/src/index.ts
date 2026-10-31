import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type { TSPPDeclarationSyntax } from "@tspp/plugin-sdk/compiler";

const pluginId = "nominal-types/newtype";

export const newtypePlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.1",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Newtype declarations",
    },
    facets: {
        compiler: {
            activate(context) {
                const kinds = context.compiler.declarationSyntaxKinds;
                const syntax: TSPPDeclarationSyntax = {
                    startTokens: [kinds.identifier],
                    binding: "type-and-value",
                    runtime: "erased",
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
                        const [value] = transformer.getArguments(node);
                        return value ? transformer.visitExpression(value) : node;
                    },
                    emitDeclaration: (node, emitter) => emitter.emitTypeAliasDeclaration(node, "newtype"),
                };
                return context.compiler.registerDeclarationSyntax(syntax);
            },
        },
        editor: {
            grammars: ["./editor/newtype.tmLanguage.json"],
        },
    },
});

export default newtypePlugin;
