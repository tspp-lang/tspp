import type {
    TSPPExpressionSyntax,
    TSPPExpressionSyntaxKinds,
} from "@tspp/plugin-sdk/compiler";

export function createValueMatchSyntax(
    kinds: TSPPExpressionSyntaxKinds,
): TSPPExpressionSyntax {
    return {
        startTokens: [kinds.identifier],
        isStart: parser => parser.token() === kinds.identifier && parser.tokenText() === "match",
        parse: parser => parser.parseTaggedUnionMatchExpression(),
        check: (node, checker, checkMode) => checker.checkTaggedUnionMatch(node, checkMode),
        transform: () => {
            throw new Error("Tagged-union match expressions are lowered to standard TypeScript during parsing.");
        },
    };
}
