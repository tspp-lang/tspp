import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { MlttTerm } from "./core";
import { cursorTokens, fileAliases, fileDeclaredNames, isTermStart, parseTermType } from "./dependent";
import { kindToTerm, ordinaryKind, parseKind, termToKind, type TypeKind, type TypeSyntaxModel } from "./kinds";
import { builtinTermNames, TermParser } from "./term-parser";

/**
 * Type-level `let X = A in B`, ordered `match T { P: R, ... }`, and type constructors `<T> =>> B` in type positions,
 * applications `F<A>` of an already parsed type, and kind annotations after type parameter and type alias names.
 * Everything lowers to ordinary type nodes: `let` and `match` to conditional types, and constructors and applications
 * to function type nodes that the checker extension interprets. Terms of the type theory, which start with a binder
 * `(x: A) ->` or a built-in name such as `Nat`, lower through the kernel (`dependent`).
 */
export function createTypeSyntax(ts: TSPPTypeScript, model: TypeSyntaxModel): readonly TSPPSyntaxExtension[] {
    const kinds = ts.SyntaxKind;

    const isLetStart = (cursor: TSPPSyntaxCursor) =>
        cursor.token() === kinds.LetKeyword && cursor.lookAhead(() => {
            cursor.nextToken();
            if (cursor.token() !== kinds.Identifier) return false;
            cursor.nextToken();
            return cursor.token() === kinds.EqualsToken;
        });
    const isMatchStart = (cursor: TSPPSyntaxCursor) =>
        cursor.token() === kinds.Identifier && cursor.tokenText() === "match" && cursor.lookAhead(() => {
            cursor.nextToken();
            if (cursor.hasPrecedingLineBreak()) return false;
            cursor.parseType();
            return cursor.token() === kinds.OpenBraceToken;
        });
    // A function over values is a term (`isTermStart`, which is asked first when parsing).
    const isConstructorStart = (cursor: TSPPSyntaxCursor) =>
        cursor.token() === kinds.LessThanToken && cursor.lookAhead(() => {
            const parameters = cursor.parseTypeParameters();
            if (!parameters || cursor.token() !== kinds.EqualsGreaterThanToken) return false;
            cursor.nextToken();
            return cursor.token() === kinds.GreaterThanToken;
        });

    const typeSyntax: TSPPSyntaxExtension = {
        position: "type",
        startTokens: [kinds.LetKeyword, kinds.Identifier, kinds.LessThanToken, kinds.OpenParenToken, kinds.OpenBraceToken],
        keywords: ["let", "match", "<", "Type", "(", "{", ...builtinTermNames],
        isStart: cursor => isLetStart(cursor) || isMatchStart(cursor) || isConstructorStart(cursor) || isTermStart(ts, model, cursor),
        parse: cursor => {
            const pos = cursor.getNodePos();
            const start = cursor.getTokenStart();
            if (isTermStart(ts, model, cursor)) return parseTermType(ts, model, cursor, start);
            const node = cursor.token() === kinds.LetKeyword ? parseLet(cursor, pos)
                : cursor.token() === kinds.Identifier ? parseMatch(cursor, pos)
                : parseConstructor(cursor, pos);
            model.authored.set(node, start);
            return node;
        },
    };

    const applicationSyntax: TSPPSyntaxExtension = {
        position: "postfix-type",
        startTokens: [kinds.LessThanToken],
        keywords: ["<"],
        // Only arguments closed by `>` apply a type: what follows a type may be any `<` the surrounding code means, as in
        // `value as number < 3`.
        isStart: cursor => cursor.token() === kinds.LessThanToken && !!cursor.precedingType && cursor.lookAhead(() => {
            cursor.parseTypeArguments();
            return cursor.getSourceText().charAt(cursor.getNodePos() - 1) === ">";
        }),
        parse: cursor => {
            const target = cursor.precedingType!;
            const typeArguments = cursor.parseTypeArguments() ?? cursor.factory.createNodeArray([]);
            return createApplication(cursor, target, typeArguments, target.pos);
        },
    };

    const annotation = (position: "type-parameter-annotation" | "type-alias-annotation"): TSPPSyntaxExtension => ({
        position,
        startTokens: [kinds.ColonToken],
        keywords: [":"],
        isStart: cursor => cursor.token() === kinds.ColonToken,
        parse: cursor => {
            const start = cursor.getTokenStart();
            cursor.parseExpected(kinds.ColonToken);
            const { kind, term } = parseAnnotation(cursor);
            const end = cursor.getNodePos();
            model.used = true;
            return declaration => {
                model.declarationKinds.set(declaration, kind);
                model.kindAnnotations.set(declaration, { start, end });
                if (!ts.isTypeAliasDeclaration(declaration)) return;
                model.termAnnotations.set(declaration, term);
                const body = model.terms.get(declaration.type);
                if (body) fileAliases(model, cursor.getSourceText()).set(ts.idText(declaration.name), body);
            };
        },
    });

    return [typeSyntax, applicationSyntax, annotation("type-parameter-annotation"), annotation("type-alias-annotation")];

    /** A kind such as `(Type, Type) => Type`, or any other term that a declaration's values belong to. */
    function parseAnnotation(cursor: TSPPSyntaxCursor): { readonly kind: TypeKind; readonly term: MlttTerm; } {
        const isKind = cursor.lookAhead(() => {
            try {
                parseKind(ts, cursor);
                return [kinds.EqualsToken, kinds.CommaToken, kinds.GreaterThanToken, kinds.ExtendsKeyword, kinds.SemicolonToken].includes(cursor.token());
            }
            catch {
                return false;
            }
        });
        if (isKind) {
            const kind = parseKind(ts, cursor);
            return { kind, term: kindToTerm(kind) };
        }
        const sourceText = cursor.getSourceText();
        const term = new TermParser(cursorTokens(ts, cursor), {
            aliases: fileAliases(model, sourceText),
            shadowed: fileDeclaredNames(model, sourceText),
        }).parseOne();
        return { kind: termToKind(term), term };
    }

    function parseLet(cursor: TSPPSyntaxCursor, pos: number): TS.TypeNode {
        cursor.nextToken();
        const nameStart = cursor.getTokenStart();
        const name = cursor.parseIdentifier();
        cursor.parseExpected(kinds.EqualsToken);
        const value = cursor.parseType();
        cursor.parseExpected(kinds.InKeyword);
        const body = cursor.parseType();
        const factory = cursor.factory;
        if (model.constructors.has(value)) {
            // An `infer` variable cannot be applied, so bind a type constructor as the redex
            // `(<Name: kind> =>> body)<value>`, which gives `Name<...>` in the body the constructor's kind.
            const parameter = cursor.finishNode(factory.createTypeParameterDeclaration(/*modifiers*/ undefined, name, /*constraint*/ undefined, /*defaultType*/ undefined), name.pos);
            model.declarationKinds.set(parameter, constructorKind(value as TS.FunctionTypeNode));
            const parameters = ts.setTextRange(factory.createNodeArray([parameter]), { pos: name.pos, end: cursor.getNodePos() });
            const constructor = createConstructor(cursor, parameters, body, pos);
            return createApplication(cursor, constructor, factory.createNodeArray([value]), pos);
        }
        const parameter = ts.setTextRange(
            factory.createTypeParameterDeclaration(/*modifiers*/ undefined, name, /*constraint*/ undefined, /*defaultType*/ undefined),
            { pos: value.end, end: value.end },
        );
        const infer = ts.setTextRange(factory.createInferTypeNode(parameter), parameter);
        const node = cursor.finishNode(createNonDistributiveConditional(cursor, value, infer, body, createEmptyNever(cursor, body.end)), pos);
        model.letBindings.set(node, { start: nameStart, length: name.end - nameStart });
        return node;
    }

    function parseMatch(cursor: TSPPSyntaxCursor, pos: number): TS.TypeNode {
        cursor.nextToken();
        const scrutinee = cursor.parseType();
        cursor.parseExpected(kinds.OpenBraceToken);
        const arms: { readonly pattern: TS.TypeNode; readonly result: TS.TypeNode; }[] = [];
        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            const pattern = cursor.parseType();
            cursor.parseExpected(kinds.ColonToken);
            const result = cursor.parseType();
            arms.push({ pattern: lowerPattern(pattern, result, cursor.factory), result });
            if (cursor.token() !== kinds.CommaToken && cursor.token() !== kinds.SemicolonToken) break;
            cursor.nextToken();
        }
        cursor.parseExpected(kinds.CloseBraceToken);
        // Later arms check a clone of the scrutinee, which keeps the scrutinee's own range. Each later arm's
        // conditional spans its arms, keeping the outer conditional's children in source order.
        let result: TS.TypeNode = createEmptyNever(cursor, arms.length ? arms[arms.length - 1].result.end : pos);
        for (let index = arms.length - 1; index >= 0; index--) {
            const { pattern, result: armResult } = arms[index];
            const end = result.end;
            result = createNonDistributiveConditional(cursor, index === 0 ? scrutinee : cloneType(scrutinee), pattern, armResult, result);
            if (index > 0) ts.setTextRange(result, { pos: pattern.pos, end });
        }
        return cursor.finishNode(result, pos);
    }

    function lowerPattern(pattern: TS.TypeNode, result: TS.TypeNode, factory: TS.NodeFactory): TS.TypeNode {
        const isWildcard = (node: TS.Node) => ts.isTypeReferenceNode(node) && !node.typeArguments
            && ts.isIdentifier(node.typeName) && ts.idText(node.typeName) === "_";
        if (isWildcard(pattern)) return ts.setTextRange(factory.createKeywordTypeNode(kinds.UnknownKeyword), pattern);

        let index = 0;
        const names = new Set<string>();
        const collectNames = (node: TS.Node): void => {
            if (ts.isIdentifier(node)) names.add(ts.idText(node));
            ts.forEachChild(node, collectNames);
        };
        const visit = (node: TS.Node): TS.Node => {
            // Leave nested plugin expressions and their own pattern scopes intact.
            if (model.authored.has(node)) return node;
            if (!isWildcard(node)) return ts.visitEachChild(node, visit, /*context*/ undefined);
            if (index === 0) {
                collectNames(pattern);
                collectNames(result);
            }
            // An independent inference variable works in constrained and invariant type arguments.
            let name: string;
            do {
                name = `_tsppWildcard${index++}`;
            } while (names.has(name));
            const parameter = ts.setTextRange(factory.createTypeParameterDeclaration(/*modifiers*/ undefined, ts.factory.createIdentifier(name)), node);
            return ts.setTextRange(factory.createInferTypeNode(parameter), node);
        };
        return visit(pattern) as TS.TypeNode;
    }

    function parseConstructor(cursor: TSPPSyntaxCursor, pos: number): TS.TypeNode {
        const parameters = cursor.parseTypeParameters();
        if (!parameters) throw new Error("Type constructor parameters were not parsed.");
        cursor.parseExpected(kinds.EqualsGreaterThanToken);
        cursor.parseExpected(kinds.GreaterThanToken);
        return createConstructor(cursor, parameters, cursor.parseType(), pos);
    }

    function createConstructor(cursor: TSPPSyntaxCursor, parameters: TS.NodeArray<TS.TypeParameterDeclaration>, body: TS.TypeNode, pos: number) {
        const node = cursor.finishNode(cursor.factory.createFunctionTypeNode(parameters, cursor.factory.createNodeArray([]), body), pos);
        model.constructors.add(node);
        model.used = true;
        return node;
    }

    function createApplication(cursor: TSPPSyntaxCursor, target: TS.TypeNode, typeArguments: TS.NodeArray<TS.TypeNode>, pos: number) {
        const factory = cursor.factory;
        const parameters = [target, ...typeArguments].map((type, index) =>
            factory.createParameterDeclaration(
                /*modifiers*/ undefined,
                /*dotDotDotToken*/ undefined,
                index === 0 ? "__tsppTarget" : `__tsppArgument${index - 1}`,
                /*questionToken*/ undefined,
                type,
                /*initializer*/ undefined,
            )
        );
        const node = cursor.finishNode(
            factory.createFunctionTypeNode(/*typeParameters*/ undefined, factory.createNodeArray(parameters), factory.createKeywordTypeNode(kinds.NeverKeyword)),
            pos,
        );
        model.applications.set(node, { target, typeArguments });
        model.authored.set(node, target.pos);
        return node;
    }

    /** The kind of a type constructor, read from its parameters' kind annotations; parameters default to `Type0`. */
    function constructorKind(node: TS.FunctionTypeNode): TypeKind {
        return {
            kind: "function",
            parameters: node.typeParameters?.map(parameter => model.declarationKinds.get(parameter) ?? ordinaryKind) ?? [],
            result: model.constructors.has(node.type) ? constructorKind(node.type as TS.FunctionTypeNode) : ordinaryKind,
        };
    }

    /** `[type]`. Declaration output reads the line a tuple starts on, so a generated `type` borrows `located`'s position. */
    function createSingletonTuple(cursor: TSPPSyntaxCursor, type: TS.TypeNode, located: TS.TypeNode) {
        const range = type.pos >= 0 ? type : { pos: located.pos, end: located.pos };
        return ts.setTextRange(cursor.factory.createTupleTypeNode(ts.setTextRange(cursor.factory.createNodeArray([type]), range)), range);
    }

    /** `[check] extends [pattern] ? whenTrue : whenFalse`, which does not distribute over unions. */
    function createNonDistributiveConditional(cursor: TSPPSyntaxCursor, check: TS.TypeNode, pattern: TS.TypeNode, whenTrue: TS.TypeNode, whenFalse: TS.TypeNode) {
        return cursor.factory.createConditionalTypeNode(createSingletonTuple(cursor, check, pattern), createSingletonTuple(cursor, pattern, pattern), whenTrue, whenFalse);
    }

    /** An empty range would make a name "missing" to the checker, so only the `never` fallback gets one. */
    function createEmptyNever(cursor: TSPPSyntaxCursor, pos: number) {
        return ts.setTextRange(cursor.factory.createKeywordTypeNode(kinds.NeverKeyword), { pos, end: pos });
    }

    /** A copy of a parsed type with generated positions, so that it never stands for source text. */
    function cloneType<T extends TS.Node>(node: T): T {
        const factory = ts.factory;
        const cloneToken = (token: TS.Node): TS.Node => factory.createToken(token.kind as never);
        const clone = (child: TS.Node): TS.Node => {
            if (ts.isIdentifier(child)) return factory.createIdentifier(ts.idText(child));
            if (ts.isStringLiteral(child)) return factory.createStringLiteral(child.text);
            if (ts.isNumericLiteral(child)) return factory.createNumericLiteral(child.text);
            if (ts.isBigIntLiteral(child)) return factory.createBigIntLiteral(child.text);
            if (ts.isNoSubstitutionTemplateLiteral(child)) return factory.createNoSubstitutionTemplateLiteral(child.text, child.rawText);
            if (ts.isTemplateHead(child)) return factory.createTemplateHead(child.text, child.rawText);
            if (ts.isTemplateMiddle(child)) return factory.createTemplateMiddle(child.text, child.rawText);
            if (ts.isTemplateTail(child)) return factory.createTemplateTail(child.text, child.rawText);
            if (ts.isThisTypeNode(child)) return factory.createThisTypeNode();
            let hasChildren = false;
            ts.forEachChild(child, () => void (hasChildren = true));
            if (!hasChildren) return cloneToken(child);
            return ts.visitEachChild(child, clone, /*context*/ undefined, /*nodesVisitor*/ undefined, cloneToken)!;
        };
        return clone(node) as T;
    }
}
