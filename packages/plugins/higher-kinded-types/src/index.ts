import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type {
    TSPPKindAnnotationParser,
    TSPPKindAnnotationSyntax,
    TSPPPostfixTypeSyntax,
    TSPPTypeSyntax,
    TSPPTypeKind,
} from "@tspp/plugin-sdk/compiler";

const pluginId = "higher-kinded-types";

function parseKind(parser: TSPPKindAnnotationParser): TSPPTypeKind {
    const kinds = parser.kinds;
    let head: TSPPTypeKind;
    if (parser.token() === kinds.openParenToken) {
        parser.nextToken();
        const parameters: TSPPTypeKind[] = [];
        while (parser.token() !== kinds.closeParenToken && parser.token() !== kinds.endOfFileToken) {
            parameters.push(parseKind(parser));
            if (parser.token() !== kinds.commaToken) break;
            parser.nextToken();
        }
        parser.parseExpected(kinds.closeParenToken);
        if (parser.token() !== kinds.equalsGreaterThanToken) {
            if (parameters.length === 1) return parameters[0];
            throw new Error("A parenthesized kind list must be followed by '=>'.");
        }
        parser.nextToken();
        return { kind: "function", parameters, result: parseKind(parser) };
    }

    const match = /^Type(0|[1-9]\d*)?$/u.exec(parser.tokenText());
    if (parser.token() !== kinds.identifier || !match) {
        throw new Error(`Expected a type kind, received '${parser.tokenText()}'.`);
    }
    parser.nextToken();
    head = { kind: "type", level: match[1] === undefined ? 0 : Number(match[1]) };
    if (parser.token() === kinds.equalsGreaterThanToken) {
        parser.nextToken();
        head = { kind: "function", parameters: [head], result: parseKind(parser) };
    }
    return head;
}

export const higherKindedTypesPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Higher-kinded types",
    },
    facets: {
        compiler: {
            activate(context) {
                const kinds = context.compiler.typeSyntaxKinds;
                const kindSyntax: TSPPKindAnnotationSyntax = {
                    startTokens: [kinds.colonToken],
                    isStart: parser => parser.token() === kinds.colonToken,
                    parse: parser => {
                        parser.parseExpected(kinds.colonToken);
                        return parseKind(parser);
                    },
                };
                const universeSyntax: TSPPTypeSyntax = {
                    startTokens: [kinds.identifier],
                    isStart: parser => parser.token() === kinds.identifier && /^Type(?:0|[1-9]\d*)?$/u.test(parser.tokenText()),
                    parse: parser => {
                        const pos = parser.getNodePos();
                        const match = /^Type(0|[1-9]\d*)?$/u.exec(parser.tokenText());
                        const level = match?.[1] === undefined ? 0 : Number(match[1]);
                        parser.nextToken();
                        return parser.finishTypeUniverse(level, pos);
                    },
                };
                const applicationSyntax: TSPPPostfixTypeSyntax = {
                    startTokens: [kinds.lessThanToken],
                    isStart: parser => parser.token() === kinds.lessThanToken,
                    parse: (target, parser) => {
                        const pos = parser.getNodePos();
                        const typeArguments = parser.parseTypeArguments() ?? [];
                        return parser.finishTypeApplication(target, typeArguments, pos);
                    },
                };
                const disposeKind = context.compiler.registerKindAnnotationSyntax(kindSyntax);
                const disposeUniverse = context.compiler.registerTypeSyntax(universeSyntax);
                const disposeApplication = context.compiler.registerPostfixTypeSyntax(applicationSyntax);
                return () => {
                    disposeApplication();
                    disposeUniverse();
                    disposeKind();
                };
            },
        },
        editor: { grammars: ["./editor/higher-kinded-types.tmLanguage.json"] },
    },
});

export default higherKindedTypesPlugin;
