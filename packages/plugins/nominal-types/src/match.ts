import type {
    TSPPExpressionSyntax,
    TSPPExpressionSyntaxKinds,
} from "@tspp/plugin-sdk/compiler";

export function createValueMatchSyntax(
    kinds: TSPPExpressionSyntaxKinds,
): TSPPExpressionSyntax {
    return {
        startTokens: [kinds.identifier],
        // `match` stays an ordinary identifier unless a scrutinee and its arms' `{` follow on the same line, so
        // `match = 6`, `match.x`, and `match(1)` followed by a block on the next line keep their TypeScript meaning.
        isStart: parser => parser.token() === kinds.identifier && parser.tokenText() === "match"
            && parser.lookAhead(() => {
                parser.nextToken();
                if (parser.hasPrecedingLineBreak()) return false;
                parser.parseAssignmentExpression();
                return parser.token() === kinds.openBraceToken && !parser.hasPrecedingLineBreak();
            }),
        parse: parser => parser.parseTaggedUnionMatchExpression(),
        check: (node, checker, checkMode) => checker.checkTaggedUnionMatch(node, checkMode),
        transform: () => {
            throw new Error("Tagged-union match expressions are lowered to standard TypeScript during parsing.");
        },
    };
}
