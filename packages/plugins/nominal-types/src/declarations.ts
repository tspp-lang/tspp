import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { markGenerated } from "@tspp/plugin-sdk";

/** What a `newtype` or `data` declaration restores in feature-rich declaration output. */
export interface AuthoredDeclaration {
    readonly keyword: "newtype" | "data";
    readonly render: (sourceFile: TS.SourceFile) => string;
}

export interface NominalDeclarations {
    readonly extension: TSPPSyntaxExtension;
    /** Type aliases of `newtype` declarations with the node of their underlying type. */
    readonly newtypes: WeakMap<TS.Node, TS.TypeNode>;
    readonly newtypeCount: () => number;
    /** Whether `declaration` is the constructor function a `newtype` lowers to. */
    readonly isNewtypeConstructor: (declaration: TS.Node) => boolean;
    /** Whether `start` is where a generated companion of a declaration in `sourceFile` names itself. */
    readonly isCompanionName: (sourceFile: TS.SourceFile, start: number) => boolean;
    /**
     * Whether `start` is the empty range of a declaration generated inside a companion in `sourceFile`, such as a
     * brand's private member, which has no source text and so no name to report on.
     */
    readonly isGeneratedDeclaration: (sourceFile: TS.SourceFile, start: number) => boolean;
}

interface ParsedVariant {
    /** Token starts of the variant name and of what follows its fields, where generated members sit. */
    readonly start: number;
    readonly valuesAt: number;
    readonly name: TS.Identifier;
    readonly fields: readonly { readonly name: TS.Identifier; readonly type: TS.TypeNode; }[];
}

/**
 * `newtype` and `data` lower to ordinary declarations while they are parsed:
 *
 * - `newtype Id<T> = U;` becomes `type Id<T> = (U) & Id.Id;`, a constructor `function Id<T>(value: U): Id<T>`,
 *   and `declare namespace Id { class Id { private __tsppNominal; } }`. The private member keeps distinct
 *   newtypes apart without adding a key that `keyof` or hover would show.
 * - `data D<T> = A | B(x: T);` becomes a union of `{ _tag, ...fields, _values }` object types, a constant for each
 *   variant without fields, and a constructor function for each variant with fields. `_values` holds the fields in
 *   order, which `match` reads by position.
 */
export function createNominalDeclarations(ts: TSPPTypeScript): NominalDeclarations {
    const kinds = ts.SyntaxKind;
    const authored = new WeakMap<TS.Node, AuthoredDeclaration>();
    /** Statements a declaration lowers to besides its type alias; feature-rich declaration output omits them. */
    const companions = new WeakSet<TS.Node>();
    const newtypes = new WeakMap<TS.Node, TS.TypeNode>();
    const newtypeConstructors = new WeakSet<TS.Node>();
    let newtypeCount = 0;

    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T => ts.setTextRange(node, { pos, end });
    /**
     * Generated nodes keep the synthesized position -1, which the checker and the editor services treat as having no
     * source text. A zero-width node would read as missing syntax. Only the root of a companion statement gets a
     * zero-width range, at the end of the declaration, so it sorts among the statements of its list.
     */
    let rootAt = -1;
    const root = <T extends TS.Node>(node: T): T => ts.setTextRange(node, { pos: rootAt, end: rootAt });
    const printer = ts.createPrinter({ removeComments: true });

    function isStartOf(keyword: "newtype" | "data") {
        return (cursor: TSPPSyntaxCursor) => cursor.tokenText() === keyword && cursor.lookAhead(() => {
            cursor.nextToken();
            return !cursor.hasPrecedingLineBreak() && cursor.token() === kinds.Identifier;
        });
    }

    /** Modifiers for a companion statement: fresh nodes of the same kinds, so no node has two parents. */
    function companionModifiers(cursor: TSPPSyntaxCursor, ambient: boolean): TS.ModifierLike[] {
        const f = cursor.factory;
        const modifiers: TS.ModifierLike[] = [];
        for (const modifier of cursor.modifiers ?? []) {
            if (modifier.kind === kinds.ExportKeyword || modifier.kind === kinds.DeclareKeyword) modifiers.push(f.createModifier(modifier.kind));
        }
        if (ambient && !modifiers.some(modifier => modifier.kind === kinds.DeclareKeyword)) modifiers.push(f.createModifier(kinds.DeclareKeyword));
        return modifiers;
    }

    function typeArgumentsFor(cursor: TSPPSyntaxCursor, typeParameters: readonly TS.TypeParameterDeclaration[] | undefined): TS.NodeArray<TS.TypeNode> | undefined {
        return typeParameters && cursor.factory.createNodeArray(typeParameters.map(parameter =>
            cursor.factory.createTypeReferenceNode(cursor.factory.createIdentifier(ts.idText(parameter.name)))));
    }

    function readonlyModifier(cursor: TSPPSyntaxCursor) {
        return [cursor.factory.createModifier(kinds.ReadonlyKeyword)];
    }

    function parenthesizedIfNeeded(cursor: TSPPSyntaxCursor, type: TS.TypeNode): TS.TypeNode {
        if (ts.isUnionTypeNode(type) || ts.isFunctionTypeNode(type) || ts.isConstructorTypeNode(type) || ts.isConditionalTypeNode(type)) {
            return range(cursor.factory.createParenthesizedType(type), type.pos, type.end);
        }
        return type;
    }

    /** `Name.Name`, the nominal brand of a `newtype` or `data` declaration. */
    function brandReference(cursor: TSPPSyntaxCursor, text: string): TS.TypeReferenceNode {
        const f = cursor.factory;
        return f.createTypeReferenceNode(f.createQualifiedName(f.createIdentifier(text), f.createIdentifier(text)));
    }

    /**
     * `declare namespace Name { export class Name { private readonly __tsppNominal!: void; } }`. The brand class takes
     * the authored name and its range: the checker prints a symbol by its declaration's source text, so a brand named
     * without source text would print as `(Missing)` wherever a type is not shown through an alias (hover on an imported
     * data constant, for example).
     */
    function brandNamespace(cursor: TSPPSyntaxCursor, name: TS.Identifier): TS.ModuleDeclaration {
        const f = cursor.factory;
        const brandMember = f.createPropertyDeclaration(
            [f.createModifier(kinds.PrivateKeyword), f.createModifier(kinds.ReadonlyKeyword)],
            f.createIdentifier("__tsppNominal"),
            f.createToken(kinds.ExclamationToken),
            f.createKeywordTypeNode(kinds.VoidKeyword),
            undefined,
        );
        const brandName = range(f.createIdentifier(ts.idText(name)), name.pos, name.end);
        const brand = f.createClassDeclaration([f.createModifier(kinds.ExportKeyword)], brandName, undefined, undefined, [brandMember]);
        const namespace = root(f.createModuleDeclaration(
            companionModifiers(cursor, /*ambient*/ true),
            range(f.createIdentifier(ts.idText(name)), name.pos, name.end),
            f.createModuleBlock([brand]),
            ts.NodeFlags.Namespace,
        ));
        companions.add(namespace);
        return namespace;
    }

    /** `value as unknown as Type`: a branded type does not overlap the plain value it brands. */
    function brandAs(cursor: TSPPSyntaxCursor, value: TS.Expression, type: TS.TypeNode): TS.Expression {
        const f = cursor.factory;
        return f.createAsExpression(f.createAsExpression(value, f.createKeywordTypeNode(kinds.UnknownKeyword)), type);
    }

    function parseNewtype(cursor: TSPPSyntaxCursor): TS.Statement[] {
        const f = cursor.factory;
        const pos = cursor.getNodePos();
        const keywordStart = cursor.getTokenStart();
        const ambient = cursor.inAmbientContext() || !!cursor.modifiers?.some(modifier => modifier.kind === kinds.DeclareKeyword);
        cursor.nextToken();
        const name = cursor.parseIdentifier();
        // The constructor needs its own copy of the type parameters and the underlying type.
        const copy = cursor.lookAhead(() => {
            const typeParameters = cursor.parseTypeParameters();
            cursor.parseExpected(kinds.EqualsToken);
            return { typeParameters, type: cursor.parseType() };
        });
        const typeParameters = cursor.parseTypeParameters();
        cursor.parseExpected(kinds.EqualsToken);
        const underlying = cursor.parseType();
        const typeEnd = cursor.getTokenStart();
        cursor.parseSemicolon();
        const end = cursor.getNodePos();
        const text = ts.idText(name);
        const at = end;
        rootAt = end;
        /** The declared name again, with the authored name's range so that it prints from source. */
        const nameAgain = () => range(f.createIdentifier(text), name.pos, name.end);

        const brand = markGenerated(ts, brandReference(cursor, text), Math.min(typeEnd, end));
        const aliasType = range(f.createIntersectionTypeNode(f.createNodeArray([parenthesizedIfNeeded(cursor, underlying), brand])), underlying.pos, at);
        const alias = range(f.createTypeAliasDeclaration(cursor.modifiers, name, typeParameters, aliasType), pos, end);

        const valueParameter = f.createParameterDeclaration(undefined, undefined, f.createIdentifier("value"), undefined, copy.type);
        const returnType = f.createTypeReferenceNode(nameAgain(), typeArgumentsFor(cursor, copy.typeParameters));
        const body = ambient ? undefined : f.createBlock([
            f.createReturnStatement(brandAs(cursor,
                f.createIdentifier("value"),
                f.createTypeReferenceNode(nameAgain(), typeArgumentsFor(cursor, copy.typeParameters)),
            )),
        ]);
        const constructor = root(f.createFunctionDeclaration(
            companionModifiers(cursor, ambient),
            undefined,
            nameAgain(),
            copy.typeParameters,
            [valueParameter],
            returnType,
            body,
        ));

        const namespace = brandNamespace(cursor, name);

        authored.set(alias, {
            keyword: "newtype",
            render: sourceFile => `newtype ${text}${printTypeParameters(typeParameters, sourceFile)} = ${printer.printNode(ts.EmitHint.Unspecified, underlying, sourceFile)};`,
        });
        newtypes.set(alias, underlying);
        newtypeCount++;
        companions.add(constructor);
        newtypeConstructors.add(constructor);
        // Companions follow the alias in the statement list, so their nodes sit at the next token.
        const after = cursor.getTokenStart();
        return [markGenerated(ts, alias, keywordStart), ...[constructor, namespace].map(statement => markGenerated(ts, statement, after, name))];
    }

    function parseVariants(cursor: TSPPSyntaxCursor): ParsedVariant[] {
        const variants: ParsedVariant[] = [];
        do {
            const variantText = cursor.tokenText();
            const start = cursor.getTokenStart();
            const name = cursor.parseIdentifier();
            const fields: { name: TS.Identifier; type: TS.TypeNode; }[] = [];
            let valuesAt = start;
            if (cursor.token() === kinds.OpenParenToken) {
                cursor.nextToken();
                while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
                    // `Some(T)` reads `T` as a field name, so explain the `name: Type` form instead of `':' expected`.
                    const unnamed = cursor.lookAhead(() => {
                        const text = cursor.tokenText();
                        cursor.nextToken();
                        if (cursor.token() === kinds.CommaToken || cursor.token() === kinds.CloseParenToken) return text;
                        // A type continues here; anything else (`value number`) only misses the colon.
                        return ["<", "[", ".", "|", "&"].includes(cursor.tokenText()) ? "Type" : undefined;
                    });
                    if (unnamed !== undefined) {
                        cursor.parseErrorAt(cursor.getTokenStart(), cursor.getTokenStart() + cursor.tokenText().length,
                            `Variant fields need a name, as in '${variantText}(value: ${unnamed})'; a bare name is a field name, not a type.`);
                        cursor.parseType();
                        if (cursor.token() !== kinds.CommaToken) break;
                        cursor.nextToken();
                        continue;
                    }
                    const fieldName = cursor.parseIdentifier();
                    cursor.parseExpected(kinds.ColonToken);
                    fields.push({ name: fieldName, type: cursor.parseType() });
                    if (cursor.token() !== kinds.CommaToken) break;
                    cursor.nextToken();
                }
                valuesAt = cursor.getTokenStart();
                cursor.parseExpected(kinds.CloseParenToken);
            }
            variants.push({ start, valuesAt, name, fields });
            if (cursor.token() !== kinds.BarToken) break;
            cursor.nextToken();
        }
        while (true);
        return variants;
    }

    /** `{ readonly _tag: "V"; readonly field: T; ...; readonly _values: readonly [T, ...] }` */
    function variantType(cursor: TSPPSyntaxCursor, variant: ParsedVariant, valueTypes: readonly TS.TypeNode[], positioned = true): TS.TypeLiteralNode {
        const f = cursor.factory;
        const tag = markGenerated(ts, f.createPropertySignature(readonlyModifier(cursor), f.createIdentifier("_tag"), undefined,
            f.createLiteralTypeNode(f.createStringLiteral(ts.idText(variant.name)))), variant.start);
        const fields = variant.fields.map(field => range(f.createPropertySignature(readonlyModifier(cursor), field.name, undefined, field.type), field.name.pos, field.type.end));
        // Without fields, `readonly never[]` makes a read of a field never, as in an arm a narrowed scrutinee cannot reach.
        const valuesTuple = f.createTypeOperatorNode(kinds.ReadonlyKeyword, variant.fields.length
            ? f.createTupleTypeNode(f.createNodeArray(valueTypes))
            : f.createArrayTypeNode(f.createKeywordTypeNode(kinds.NeverKeyword)));
        const values = markGenerated(ts, f.createPropertySignature(readonlyModifier(cursor), f.createIdentifier("_values"), undefined, valuesTuple), variant.valuesAt);
        const literal = f.createTypeLiteralNode([tag, ...fields, values]);
        return positioned ? range(literal, variant.name.pos, variant.valuesAt) : literal;
    }

    function parseData(cursor: TSPPSyntaxCursor): TS.Statement[] {
        const f = cursor.factory;
        const pos = cursor.getNodePos();
        const keywordStart = cursor.getTokenStart();
        const ambient = cursor.inAmbientContext() || !!cursor.modifiers?.some(modifier => modifier.kind === kinds.DeclareKeyword);
        cursor.nextToken();
        const name = cursor.parseIdentifier();
        // Field types appear in the alias, its `_values` tuples, and the constructors, each a separate copy.
        const parseRest = () => {
            const typeParameters = cursor.parseTypeParameters();
            cursor.parseExpected(kinds.EqualsToken);
            return { typeParameters, variants: parseVariants(cursor) };
        };
        const valuesCopy = cursor.lookAhead(parseRest);
        const constructorCopies = valuesCopy.variants.map(variant => variant.fields.length ? cursor.lookAhead(parseRest) : undefined);
        const { typeParameters, variants } = parseRest();
        const variantsEnd = cursor.getTokenStart();
        cursor.parseSemicolon();
        const end = cursor.getNodePos();
        const at = end;
        rootAt = end;
        const text = ts.idText(name);

        const union = range(f.createUnionTypeNode(f.createNodeArray(variants.map((variant, index) =>
            variantType(cursor, variant, valuesCopy.variants[index]?.fields.map(field => field.type) ?? [])))), variants[0]?.name.pos ?? at, at);
        // Data values are nominal: a structural lookalike lacks the brand.
        const branded = range(f.createIntersectionTypeNode(f.createNodeArray([
            range(f.createParenthesizedType(union), union.pos, union.end),
            markGenerated(ts, brandReference(cursor, text), Math.min(variantsEnd, end)),
        ])), union.pos, at);
        const alias = range(f.createTypeAliasDeclaration(cursor.modifiers, name, typeParameters, branded), pos, end);

        const statements: TS.Statement[] = [alias, brandNamespace(cursor, name)];
        variants.forEach((variant, index) => {
            const variantName = ts.idText(variant.name);
            const tag = f.createPropertyAssignment(f.createIdentifier("_tag"), f.createStringLiteral(variantName));
            const constructorCopy = constructorCopies[index];
            if (!variant.fields.length || !constructorCopy) {
                const type = f.createIntersectionTypeNode(f.createNodeArray([
                    variantType(cursor, { start: keywordStart, valuesAt: keywordStart, name: f.createIdentifier(variantName), fields: [] }, [], /*positioned*/ false),
                    brandReference(cursor, text),
                ]));
                const value = f.createObjectLiteralExpression([
                    tag,
                    f.createPropertyAssignment(f.createIdentifier("_values"), f.createArrayLiteralExpression(f.createNodeArray([]))),
                ]);
                const constantName = range(f.createIdentifier(variantName), variant.name.pos, variant.name.end);
                const declaration = ambient
                    ? f.createVariableDeclaration(constantName, undefined, type)
                    : f.createVariableDeclaration(constantName, undefined, undefined, brandAs(cursor, value, type));
                const constant = root(f.createVariableStatement(companionModifiers(cursor, ambient), f.createVariableDeclarationList([declaration], ts.NodeFlags.Const)));
                companions.add(constant);
                statements.push(constant);
                return;
            }
            const fields = constructorCopy.variants[index]?.fields ?? [];
            const parameters = fields.map(field => f.createParameterDeclaration(undefined, undefined, f.createIdentifier(ts.idText(field.name)), undefined, field.type));
            const reference = (fieldName: TS.Identifier) => f.createIdentifier(ts.idText(fieldName));
            const dataType = () => f.createTypeReferenceNode(range(f.createIdentifier(text), name.pos, name.end), typeArgumentsFor(cursor, typeParameters));
            const body = ambient ? undefined : f.createBlock([
                f.createReturnStatement(brandAs(cursor, f.createObjectLiteralExpression([
                    tag,
                    ...fields.map(field => f.createShorthandPropertyAssignment(reference(field.name))),
                    f.createPropertyAssignment(f.createIdentifier("_values"), f.createArrayLiteralExpression(f.createNodeArray(fields.map(field => reference(field.name))))),
                ]), dataType())),
            ]);
            const constructorTypeParameters = constructorCopy.typeParameters;
            const returnType = dataType();
            const constructor = root(f.createFunctionDeclaration(
                companionModifiers(cursor, ambient),
                undefined,
                range(f.createIdentifier(variantName), variant.name.pos, variant.name.end),
                constructorTypeParameters,
                parameters,
                returnType,
                body,
            ));
            companions.add(constructor);
            statements.push(constructor);
        });

        authored.set(alias, {
            keyword: "data",
            render: sourceFile => `data ${text}${printTypeParameters(typeParameters, sourceFile)} = ${variants.map(variant =>
                variant.fields.length
                    ? `${ts.idText(variant.name)}(${variant.fields.map(field => `${ts.idText(field.name)}: ${printer.printNode(ts.EmitHint.Unspecified, field.type, sourceFile)}`).join(", ")})`
                    : ts.idText(variant.name)).join(" | ")};`,
        });
        // Companions follow the alias in the statement list, so their nodes sit at the next token.
        const after = cursor.getTokenStart();
        return [markGenerated(ts, alias, keywordStart), ...statements.slice(1).map(statement => markGenerated(ts, statement, after, name))];

    }

    function printTypeParameters(typeParameters: TS.NodeArray<TS.TypeParameterDeclaration> | undefined, sourceFile: TS.SourceFile): string {
        if (!typeParameters?.length) return "";
        const text = sourceFile.text;
        // The authored parameters may carry plugin syntax such as kind annotations, so restore their source text.
        return `<${typeParameters.map(parameter => text.slice(skipTrivia(text, parameter.pos), parameter.end)).join(", ")}>`;
    }

    function skipTrivia(text: string, pos: number): number {
        const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, text, undefined, pos);
        scanner.scan();
        return scanner.getTokenStart();
    }

    const newtypeStart = isStartOf("newtype");
    const dataStart = isStartOf("data");
    const extension: TSPPSyntaxExtension = {
        position: "declaration",
        startTokens: [kinds.Identifier],
        keywords: ["newtype", "data"],
        isStart: cursor => newtypeStart(cursor) || dataStart(cursor),
        parse: cursor => cursor.tokenText() === "newtype" ? parseNewtype(cursor) : parseData(cursor),
        restoreDeclaration: statement => {
            const original = ts.getOriginalNode(statement);
            if (companions.has(original)) return "";
            const declaration = authored.get(original);
            if (!declaration) return undefined;
            let sourceFile: TS.Node = original;
            while (!ts.isSourceFile(sourceFile)) sourceFile = sourceFile.parent;
            const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === kinds.ExportKeyword);
            return `${exported ? "export " : ""}${declaration.render(sourceFile)}`;
        },
    };
    /** Per source file: where companions name themselves, and where declarations generated inside them sit. */
    const companionPositions = new WeakMap<TS.SourceFile, { readonly names: ReadonlySet<number>; readonly empty: ReadonlySet<number>; }>();
    const positionsIn = (sourceFile: TS.SourceFile) => {
        let positions = companionPositions.get(sourceFile);
        if (!positions) {
            const names = new Set<number>();
            const empty = new Set<number>();
            const visitGenerated = (node: TS.Node): void => {
                const generatedName = (node as TS.Node & { readonly name?: TS.Node; }).name;
                if (node.pos >= 0 && node.pos === node.end && generatedName?.pos === -1) empty.add(node.pos);
                ts.forEachChild(node, visitGenerated);
            };
            const visit = (node: TS.Node): void => {
                if (companions.has(node)) {
                    const named = node as TS.Node & { readonly name?: TS.Node; };
                    if (named.name) names.add(skipTrivia(sourceFile.text, named.name.pos));
                    if (ts.isVariableStatement(node)) for (const declaration of node.declarationList.declarations) names.add(skipTrivia(sourceFile.text, declaration.name.pos));
                    ts.forEachChild(node, visitGenerated);
                    return;
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            companionPositions.set(sourceFile, positions = { names, empty });
        }
        return positions;
    };
    const isCompanionName = (sourceFile: TS.SourceFile, start: number) => positionsIn(sourceFile).names.has(start);
    const isGeneratedDeclaration = (sourceFile: TS.SourceFile, start: number) => positionsIn(sourceFile).empty.has(start);
    return {
        extension,
        newtypes,
        newtypeCount: () => newtypeCount,
        isNewtypeConstructor: declaration => newtypeConstructors.has(declaration),
        isCompanionName,
        isGeneratedDeclaration,
    };
}
