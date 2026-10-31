import type {
    TSPPDeclarationSyntax,
    TSPPDeclarationSyntaxKinds,
    TSPPTaggedUnionField,
    TSPPTaggedUnionVariant,
} from "@tspp/plugin-sdk/compiler";

export function createDataDeclarationSyntax(
    kinds: TSPPDeclarationSyntaxKinds,
): TSPPDeclarationSyntax {
    return {
        startTokens: [kinds.identifier],
        binding: "type",
        runtime: "emitted",
        isStart: parser => parser.tokenText() === "data" && parser.lookAhead(() => {
            parser.nextToken();
            return !parser.hasPrecedingLineBreak() && /^[A-Za-z_$][\w$]*$/.test(parser.tokenText());
        }),
        parse: parser => {
            const pos = parser.getNodePos();
            parser.nextToken();
            const name = parser.parseIdentifier();
            const typeParameters = parser.parseTypeParameters();
            parser.parseExpected(kinds.equalsToken);

            const variants: TSPPTaggedUnionVariant[] = [];
            do {
                const variantName = parser.parseIdentifier();
                const fields: TSPPTaggedUnionField[] = [];
                if (parser.token() === kinds.openParenToken) {
                    parser.nextToken();
                    while (parser.token() !== kinds.closeParenToken) {
                        const fieldName = parser.parseIdentifier();
                        parser.parseExpected(kinds.colonToken);
                        fields.push({ name: fieldName, type: parser.parseType() });
                        if (parser.token() !== kinds.commaToken) break;
                        parser.nextToken();
                    }
                    parser.parseExpected(kinds.closeParenToken);
                }
                variants.push({ name: variantName, fields });
                if (parser.token() !== kinds.barToken) break;
                parser.nextToken();
            } while (true);

            parser.parseSemicolon();
            return parser.finishTaggedUnionDeclaration(name, typeParameters, variants, pos);
        },
        getDeclaredType: (node, checker, underlyingType) => checker.createNominalType(node, underlyingType),
        getValueType: (node, checker) => checker.createTaggedUnionConstructorType(node),
        transform: (node, transformer) => transformer.createTaggedUnionStatements(node),
        emitDeclaration: (node, emitter) => emitter.emitTaggedUnionDeclaration(node, "data"),
        emitCompatibilityDeclaration: (node, emitter) => emitter.emitCompatibilityTaggedUnionDeclaration(node),
    };
}
