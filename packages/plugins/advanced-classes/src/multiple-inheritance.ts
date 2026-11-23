import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { getTypeArgumentCopies } from "./heritage";
import { createMappedSuper, type MappedSuper } from "./mapped-super";

export const DIAGNOSTIC_MULTIPLE_BASE_SYNTAX = 19120;
export const DIAGNOSTIC_INVALID_ADDITIONAL_BASE = 19121;
export const DIAGNOSTIC_INHERITED_MEMBER_CONFLICT = 19122;
export const DIAGNOSTIC_UNIMPLEMENTED_ABSTRACT_MEMBER = 19123;
export const DIAGNOSTIC_DUPLICATE_BASE = 19124;
export const DIAGNOSTIC_PROTOTYPE_OPERATION = 19125;

/** The key under which a class used as an additional base hands out copies of itself on another base. */
export const mixinKey = "ts-plus-plus.mixin";

/** A class written with more than one base, as parsed. */
export interface MultipleBases {
    readonly name: string;
    /** The authored base expressions, first base first. Each is a value in the class's heritage, where the checker resolves it. */
    readonly bases: readonly TS.Expression[];
    /** Whether the class was written `abstract`. */
    readonly isAbstract: boolean;
    /** The end of the class, where the generated interface sits without width. */
    readonly end: number;
    readonly mapped?: MappedSuper;
}

/** A call that asks an additional base for its copy on the bases before it. */
export interface CopyCall {
    readonly extra: TS.Expression;
    readonly base: TS.Expression;
    readonly text: string;
    readonly className: string;
}

export interface LoweredBases {
    /** What the class extends in place of its bases. */
    readonly heritage: TS.ExpressionWithTypeArguments;
    /** The modifiers the class keeps; `export default` moves to a statement of its own. */
    readonly classModifiers: TS.ModifierLike[];
    /** Placed after the class: the interface that adds the other bases' instance side, and a default export. */
    readonly after: TS.Statement[];
}

/**
 * Multiple inheritance. `class C extends A, B, D` lowers to a class that extends an expression typed as `A` with the static
 * sides of the others, and an interface of the same name that extends `B` and `D`, so the checker sees every base. At run
 * time the expression is `D`'s copy of itself on `B`'s copy of itself on `A`: every class used as an additional base is
 * emitted as a factory of such copies, which share its private state, its static fields, and `instanceof`.
 */
export function createMultipleInheritance(ts: TSPPTypeScript) {
    const kinds = ts.SyntaxKind;
    const parsed = new WeakMap<TS.Node, MultipleBases>();
    const sourceCopies = new WeakSet<TS.Node>();
    /** The calls that ask an additional base for its copy, which emit checks. */
    const copyCalls = new WeakMap<TS.Node, CopyCall>();
    let used = false;
    const getMultipleBases = (declaration: TS.Node) => parsed.get(ts.getOriginalNode(declaration));

    const isEntityNameExpression = (node: TS.Expression): boolean =>
        ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && isEntityNameExpression(node.expression);

    const entityText = (node: TS.Expression): string =>
        ts.isIdentifier(node) ? ts.idText(node) : ts.isPropertyAccessExpression(node) ? `${entityText(node.expression)}.${ts.idText(node.name as TS.Identifier)}` : "";

    const mapped = createMappedSuper(ts, entityText);

    /**
     * Whether the class at `class` lists more than one base. Runs inside a look-ahead: header clauses in braces are skipped,
     * and the scan stops at the body, at `implements`, or at a semicolon.
     */
    function hasMultipleBases(cursor: TSPPSyntaxCursor): boolean {
        cursor.nextToken();
        let depth = 0;
        let inExtends = false;
        while (cursor.token() !== kinds.EndOfFileToken) {
            const token = cursor.token();
            if (depth === 0) {
                if (token === kinds.ExtendsKeyword) inExtends = true;
                else if (token === kinds.ImplementsKeyword || token === kinds.SemicolonToken) return false;
                else if (token === kinds.CommaToken && inExtends) return true;
                else if (token === kinds.OpenBraceToken) {
                    if (inExtends) return false;
                    // A header clause, or the body of a class without bases.
                    let braces = 0;
                    do {
                        if (cursor.token() === kinds.OpenBraceToken) braces++;
                        else if (cursor.token() === kinds.CloseBraceToken) braces--;
                        cursor.nextToken();
                    }
                    while (braces > 0 && cursor.token() !== kinds.EndOfFileToken);
                    const next = cursor.token();
                    if (next !== kinds.ExtendsKeyword && next !== kinds.ImplementsKeyword && next !== kinds.Identifier && next !== kinds.OpenParenToken) return false;
                    continue;
                }
            }
            if (token === kinds.OpenParenToken || token === kinds.OpenBracketToken || token === kinds.LessThanToken) depth++;
            else if (token === kinds.CloseParenToken || token === kinds.CloseBracketToken || token === kinds.GreaterThanToken) depth = Math.max(0, depth - 1);
            cursor.nextToken();
        }
        return false;
    }

    /** Reports a syntax error with this feature's code and gives back whether the bases can be lowered. */
    function checkBases(cursor: TSPPSyntaxCursor, nameNode: TS.Identifier | undefined, types: readonly TS.ExpressionWithTypeArguments[]): boolean {
        let valid = true;
        if (!nameNode || !ts.idText(nameNode)) {
            cursor.parseErrorAt(types[0].pos, types[types.length - 1].end, "A class with more than one base must have a name.", DIAGNOSTIC_MULTIPLE_BASE_SYNTAX);
            valid = false;
        }
        for (const type of types) {
            if (!isEntityNameExpression(type.expression)) {
                cursor.parseErrorAt(type.expression.pos, type.expression.end, "A class with more than one base must name each base, such as 'Base' or 'module.Base'.", DIAGNOSTIC_MULTIPLE_BASE_SYNTAX);
                valid = false;
            }
        }
        return valid;
    }

    /**
     * The parts of the lowered class. Everything written stays in the class's heritage, where the checker resolves it and
     * editor services find it; the interface holds only copies without positions. Services and the formatter walk
     * statements in order, so a statement after the class must not hold any of its text.
     */
    function lowerBases(
        cursor: TSPPSyntaxCursor,
        nameNode: TS.Identifier,
        typeParameters: TS.NodeArray<TS.TypeParameterDeclaration> | undefined,
        types: readonly TS.ExpressionWithTypeArguments[],
        modifiers: readonly TS.ModifierLike[],
        mappedMode = false,
    ): LoweredBases {
        const f = cursor.factory;
        const className = ts.idText(nameNode);
        const range = <T extends TS.Node>(node: T, from: TS.TextRange): T => ts.setTextRange(node, { pos: from.pos, end: from.end });
        // The parser's factory has no parenthesizer rules, which take plain arrays for lists.
        const list = <T extends TS.Node>(nodes: readonly T[]) => f.createNodeArray(nodes);
        /** A copy of a base's name: in its source range for errors the checker reports in it, or without one. */
        const copyName = (node: TS.Expression, positioned: boolean, entity: boolean): TS.Expression | TS.EntityName => {
            const place = <T extends TS.Node>(copy: T, from: TS.Node): T => {
                // Without a position, not an empty one: an empty name reads as missing, and so does an empty access.
                if (!positioned) return ts.setTextRange(copy, { pos: -1, end: -1 });
                sourceCopies.add(copy);
                return range(copy, from);
            };
            if (ts.isIdentifier(node)) return place(f.createIdentifier(ts.idText(node)), node);
            const access = node as TS.PropertyAccessExpression;
            const name = place(f.createIdentifier(ts.idText(access.name as TS.Identifier)), access.name);
            return place(entity
                ? f.createQualifiedName(copyName(access.expression, positioned, true) as TS.EntityName, name)
                : f.createPropertyAccessExpression(copyName(access.expression, positioned, false) as TS.Expression, name), node);
        };
        const typeOf = (node: TS.Expression) => {
            const query = f.createTypeQueryNode(copyName(node, true, true) as TS.EntityName);
            sourceCopies.add(query);
            return range(query, node);
        };
        const anyOf = (node: TS.Expression) => f.createParenthesizedExpression(f.createAsExpression(node, f.createKeywordTypeNode(kinds.AnyKeyword)));
        const global = () => anyOf(f.createIdentifier("globalThis"));

        // `typeof A & { [B in keyof typeof B as B extends "prototype" ? never : B]: (typeof B)[B] } & ...`: the first base's
        // construct signatures and the static side of every base. Written without library types, which a project may not load.
        // The key is named after the base, a copy of its written name: declaration output prints the type from these nodes,
        // and a name needs source text. `typeof` reads the value, so the key never stands for the class.
        const staticSide = (base: TS.Expression) => {
            const written = ts.isPropertyAccessExpression(base) ? base.name as TS.Identifier : base as TS.Identifier;
            const keyName = () => {
                const name = range(f.createIdentifier(ts.idText(written)), written);
                sourceCopies.add(name);
                return name;
            };
            return f.createMappedTypeNode(
                /*readonlyToken*/ undefined,
                f.createTypeParameterDeclaration(undefined, keyName(), f.createTypeOperatorNode(kinds.KeyOfKeyword, typeOf(base))),
                f.createConditionalTypeNode(f.createTypeReferenceNode(keyName()), f.createLiteralTypeNode(f.createStringLiteral("prototype")), f.createKeywordTypeNode(kinds.NeverKeyword), f.createTypeReferenceNode(keyName())),
                /*questionToken*/ undefined,
                f.createIndexedAccessTypeNode(typeOf(base), f.createTypeReferenceNode(keyName())),
                /*members*/ undefined,
            );
        };
        const constructorType = mappedMode ? f.createConstructorTypeNode(undefined, undefined, [
            f.createParameterDeclaration(undefined, f.createToken(kinds.DotDotDotToken), "args", undefined, f.createArrayTypeNode(f.createKeywordTypeNode(kinds.AnyKeyword))),
        ], f.createTypeReferenceNode(copyName(types[0].expression, true, true) as TS.EntityName, getTypeArgumentCopies(types[0]))) : typeOf(types[0].expression);
        const baseType = f.createIntersectionTypeNode(list([constructorType, ...(mappedMode ? types : types.slice(1)).map(type => staticSide(type.expression))]));

        // Each additional base hands out its copy on what comes before it. Emit checks that it can: the file that declares it
        // may have been emitted before this class used it, as an incremental build does when only this file changed.
        const key = f.createCallExpression(f.createPropertyAccessExpression(f.createPropertyAccessExpression(global(), "Symbol"), "for"), undefined, list([f.createStringLiteral(mixinKey)]));
        let value: TS.Expression = types[0].expression;
        for (const type of types.slice(1)) {
            const call = f.createCallExpression(f.createElementAccessExpression(anyOf(type.expression), key), undefined, list([value]));
            copyCalls.set(call, { extra: type.expression, base: value, text: entityText(type.expression), className });
            value = call;
        }
        // A class in an ambient context has no value to extend; the type says what it is.
        const ambient = cursor.inAmbientContext() || modifiers.some(modifier => modifier.kind === kinds.DeclareKeyword);
        const heritageValue = f.createParenthesizedExpression(f.createAsExpression(ambient ? anyOf(value) : value, baseType));

        const isExport = modifiers.some(modifier => modifier.kind === kinds.ExportKeyword);
        const isDefault = modifiers.some(modifier => modifier.kind === kinds.DefaultKeyword);
        // A merged declaration cannot be a default export, so `export default class` exports the merged name afterwards.
        const classModifiers = isDefault ? modifiers.filter(modifier => modifier.kind !== kinds.ExportKeyword && modifier.kind !== kinds.DefaultKeyword) : [...modifiers];
        const interfaceDeclaration = f.createInterfaceDeclaration(
            isExport && !isDefault ? [f.createModifier(kinds.ExportKeyword)] : undefined,
            f.createIdentifier(className),
            // Merged declarations need the same names; the class holds the constraints and defaults.
            typeParameters?.map(parameter => f.createTypeParameterDeclaration(undefined, f.createIdentifier(ts.idText(parameter.name)))),
            [f.createHeritageClause(kinds.ExtendsKeyword, list(types.slice(1).map(type =>
                f.createExpressionWithTypeArguments(copyName(type.expression, false, false) as TS.Expression, getTypeArgumentCopies(type))
            )))],
            [],
        );
        const after: TS.Statement[] = [interfaceDeclaration];
        if (isDefault) after.push(f.createExportDeclaration(undefined, false, f.createNamedExports([f.createExportSpecifier(false, f.createIdentifier(className), "default")])));

        return {
            heritage: range(f.createExpressionWithTypeArguments(heritageValue, mappedMode ? undefined : types[0].typeArguments), { pos: types[0].pos, end: types[types.length - 1].end }),
            classModifiers,
            after,
        };
    }

    function register(declaration: TS.ClassDeclaration, bases: readonly TS.Expression[], isAbstract: boolean, end: number, mappedInfo?: MappedSuper): void {
        used = true;
        parsed.set(declaration, { name: declaration.name ? ts.idText(declaration.name) : "", bases, isAbstract, end, mapped: mappedInfo });
    }

    return {
        ...mapped,
        hasMultipleBases,
        checkBases,
        lowerBases,
        register,
        getMultipleBases,
        isSourceCopy: (node: TS.Node) => sourceCopies.has(node),
        getCopyCall: (node: TS.Node) => copyCalls.get(ts.getOriginalNode(node)),
        used: () => used,
        entityText,
    };
}

export type MultipleInheritance = ReturnType<typeof createMultipleInheritance>;
