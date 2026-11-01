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
                const variantText = parser.tokenText();
                const variantName = parser.parseIdentifier();
                const fields: TSPPTaggedUnionField[] = [];
                if (parser.token() === kinds.openParenToken) {
                    parser.nextToken();
                    while (parser.token() !== kinds.closeParenToken) {
                        // `Some(T)` reads `T` as a field name, so explain the `name: Type` form instead of `':' expected`.
                        const unnamed = parser.lookAhead(() => {
                            const text = parser.tokenText();
                            parser.nextToken();
                            if (parser.token() === kinds.commaToken || parser.token() === kinds.closeParenToken) return text;
                            // A type continues here; anything else (`value number`) only misses the colon.
                            return ["<", "[", ".", "|", "&"].includes(parser.tokenText()) ? "Type" : undefined;
                        });
                        if (unnamed !== undefined) {
                            parser.parseErrorAtCurrentToken(
                                `Variant fields need a name, as in '${variantText}(value: ${unnamed})'; a bare name is a field name, not a type.`,
                            );
                            parser.parseType();
                            if (parser.token() !== kinds.commaToken) break;
                            parser.nextToken();
                            continue;
                        }
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
