import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

export function blockContainsField(ts: TSPPTypeScript, block: TS.Block): boolean {
    let found = false;
    const check = (node: TS.Node) => {
        if (ts.isIdentifier(node) && ts.idText(node) === "field") {
            found = true;
            return;
        }
        if (
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.name) &&
            ts.idText(node.name).startsWith("__field_")
        ) {
            found = true;
            return;
        }
        if (!found) ts.forEachChild(node, check);
    };
    check(block);
    return found;
}

export function replaceFieldInBlock(
    ts: TSPPTypeScript,
    f: TS.NodeFactory,
    block: TS.Block,
    backingPropId: string,
): TS.Block {
    const transformer = (node: TS.Node): TS.Node => {
        if (ts.isPropertyAccessExpression(node)) {
            if (ts.isIdentifier(node.name) && ts.idText(node.name).startsWith("__field_")) {
                return node;
            }
            return f.updatePropertyAccessExpression(
                node,
                ts.visitNode(node.expression, transformer) as TS.Expression,
                node.name,
            );
        }
        if (ts.isIdentifier(node) && ts.idText(node) === "field") {
            return f.createPropertyAccessExpression(
                f.createThis(),
                f.createIdentifier(backingPropId),
            );
        }
        return ts.visitEachChild(node, transformer, undefined as any);
    };
    return ts.visitEachChild(block, transformer, undefined as any);
}

export function cloneTypeNode(
    ts: TSPPTypeScript,
    f: TS.NodeFactory,
    t: TS.TypeNode | undefined,
): TS.TypeNode | undefined {
    if (!t) return undefined;
    const kinds = ts.SyntaxKind;
    if (t.kind === kinds.NumberKeyword) return f.createKeywordTypeNode(kinds.NumberKeyword);
    if (t.kind === kinds.StringKeyword) return f.createKeywordTypeNode(kinds.StringKeyword);
    if (t.kind === kinds.BooleanKeyword) return f.createKeywordTypeNode(kinds.BooleanKeyword);
    if (t.kind === kinds.AnyKeyword) return f.createKeywordTypeNode(kinds.AnyKeyword);
    if (t.kind === kinds.VoidKeyword) return f.createKeywordTypeNode(kinds.VoidKeyword);
    if (t.kind === kinds.UnknownKeyword) return f.createKeywordTypeNode(kinds.UnknownKeyword);
    if (ts.isTypeReferenceNode(t) && ts.isIdentifier(t.typeName)) {
        return f.createTypeReferenceNode(f.createIdentifier(ts.idText(t.typeName)), t.typeArguments);
    }
    return t;
}

export interface ParseFieldPropertyOptions {
    ts: TSPPTypeScript;
    cursor: TSPPSyntaxCursor;
    memberStart: number;
    accessKind?: TS.SyntaxKind;
    isStatic: boolean;
    isReadonly: boolean;
    isOverride: boolean;
    addedBackingFields: Set<string>;
    members: TS.ClassElement[];
}

export function parseFieldProperty(opts: ParseFieldPropertyOptions): void {
    const { ts, cursor, memberStart, accessKind, isStatic, isReadonly, isOverride, addedBackingFields, members } = opts;
    const kinds = ts.SyntaxKind;
    const f = cursor.factory;

    const propName = cursor.parseIdentifier();
    const propNameText = ts.idText(propName);
    let propType: TS.TypeNode | undefined;
    if (cursor.token() === kinds.ColonToken) {
        cursor.nextToken();
        propType = cursor.parseType();
    }
    let propInit: TS.Expression | undefined;
    if (cursor.token() === kinds.EqualsToken) {
        cursor.nextToken();
        propInit = cursor.parseAssignmentExpression();
    }

    const backingPropId = `__field_${propNameText}`;

    if (cursor.token() === kinds.OpenBraceToken) {
        cursor.nextToken();
        let getterBody: TS.Block | undefined;
        let getterReturnType: TS.TypeNode | undefined;
        let getterRange: { pos: number; end: number } | undefined;
        let setterParamName: TS.Identifier | undefined;
        let setterParamType: TS.TypeNode | undefined;
        let setterParamRange: { pos: number; end: number } | undefined;
        let setterBody: TS.Block | undefined;
        let setterRange: { pos: number; end: number } | undefined;

        while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
            if (cursor.token() === kinds.SemicolonToken) {
                cursor.nextToken();
                continue;
            }
            const subText = cursor.tokenText();
            if (subText === "get") {
                const getStart = cursor.getTokenStart();
                cursor.nextToken();
                cursor.parseExpected(kinds.OpenParenToken);
                cursor.parseExpected(kinds.CloseParenToken);
                if (cursor.token() === kinds.ColonToken) {
                    cursor.nextToken();
                    getterReturnType = cursor.parseType();
                }
                getterBody = cursor.parseStatement() as TS.Block;
                getterRange = { pos: getStart, end: cursor.getNodePos() };
            } else if (subText === "set") {
                const setStart = cursor.getTokenStart();
                cursor.nextToken();
                cursor.parseExpected(kinds.OpenParenToken);
                const paramStart = cursor.getTokenStart();
                setterParamName = cursor.parseIdentifier();
                if (cursor.token() === kinds.ColonToken) {
                    cursor.nextToken();
                    setterParamType = cursor.parseType();
                }
                setterParamRange = { pos: paramStart, end: cursor.getNodePos() };
                cursor.parseExpected(kinds.CloseParenToken);
                setterBody = cursor.parseStatement() as TS.Block;
                setterRange = { pos: setStart, end: cursor.getNodePos() };
            } else {
                cursor.nextToken();
            }
        }
        cursor.parseExpected(kinds.CloseBraceToken);

        const cloneType = (t: TS.TypeNode | undefined) => cloneTypeNode(ts, f, t);

        const backingModifiers: TS.Modifier[] = [f.createModifier(kinds.PrivateKeyword)];
        if (isStatic) backingModifiers.push(f.createModifier(kinds.StaticKeyword));
        const backingProp = f.createPropertyDeclaration(
            f.createNodeArray(backingModifiers),
            f.createIdentifier(backingPropId),
            undefined,
            propType,
            propInit,
        );
        ts.setTextRange(backingProp, { pos: memberStart, end: memberStart });
        members.push(backingProp);
        addedBackingFields.add(backingPropId);

        if (getterBody) {
            const getterModifiers: TS.Modifier[] = [];
            if (accessKind) getterModifiers.push(f.createModifier(accessKind as any));
            if (isStatic) getterModifiers.push(f.createModifier(kinds.StaticKeyword));
            if (isOverride) getterModifiers.push(f.createModifier(kinds.OverrideKeyword));
            const getter = f.createGetAccessorDeclaration(
                getterModifiers.length ? f.createNodeArray(getterModifiers) : undefined,
                f.createIdentifier(propNameText),
                f.createNodeArray([]),
                getterReturnType ?? cloneType(propType),
                replaceFieldInBlock(ts, f, getterBody, backingPropId),
            );
            ts.setTextRange(getter, getterRange ?? { pos: memberStart, end: cursor.getNodePos() });
            members.push(getter);
        }

        if (setterBody && !isReadonly) {
            const setterModifiers: TS.Modifier[] = [];
            if (accessKind) setterModifiers.push(f.createModifier(accessKind as any));
            if (isStatic) setterModifiers.push(f.createModifier(kinds.StaticKeyword));
            const param = f.createParameterDeclaration(
                undefined,
                undefined,
                setterParamName ?? f.createIdentifier("value"),
                undefined,
                setterParamType ?? cloneType(propType),
                undefined,
            );
            if (setterParamRange) {
                ts.setTextRange(param, setterParamRange);
            }
            const setter = f.createSetAccessorDeclaration(
                setterModifiers.length ? f.createNodeArray(setterModifiers) : undefined,
                f.createIdentifier(propNameText),
                f.createNodeArray([param]),
                replaceFieldInBlock(ts, f, setterBody, backingPropId),
            );
            ts.setTextRange(setter, setterRange ?? { pos: memberStart, end: cursor.getNodePos() });
            members.push(setter);
        }
    } else {
        cursor.parseOptional(kinds.SemicolonToken);
        const backingModifiers: TS.Modifier[] = [f.createModifier(kinds.PrivateKeyword)];
        if (isStatic) backingModifiers.push(f.createModifier(kinds.StaticKeyword));
        const backingProp = f.createPropertyDeclaration(
            f.createNodeArray(backingModifiers),
            f.createIdentifier(backingPropId),
            undefined,
            propType,
            propInit,
        );
        ts.setTextRange(backingProp, { pos: memberStart, end: memberStart });
        members.push(backingProp);
        addedBackingFields.add(backingPropId);

        const getterModifiers: TS.Modifier[] = [];
        if (accessKind) getterModifiers.push(f.createModifier(accessKind as any));
        if (isStatic) getterModifiers.push(f.createModifier(kinds.StaticKeyword));
        if (isOverride) getterModifiers.push(f.createModifier(kinds.OverrideKeyword));
        const getter = f.createGetAccessorDeclaration(
            getterModifiers.length ? f.createNodeArray(getterModifiers) : undefined,
            propName,
            f.createNodeArray([]),
            cloneTypeNode(ts, f, propType),
            f.createBlock(
                f.createNodeArray([
                    f.createReturnStatement(
                        f.createPropertyAccessExpression(
                            f.createThis(),
                            f.createIdentifier(backingPropId),
                        ),
                    ),
                ]),
                true,
            ),
        );
        ts.setTextRange(getter, { pos: memberStart, end: cursor.getNodePos() });
        members.push(getter);

        if (!isReadonly) {
            const setterModifiers: TS.Modifier[] = [];
            if (accessKind) setterModifiers.push(f.createModifier(accessKind as any));
            if (isStatic) setterModifiers.push(f.createModifier(kinds.StaticKeyword));
            const setterParam = f.createParameterDeclaration(
                undefined,
                undefined,
                f.createIdentifier("value"),
                undefined,
                cloneTypeNode(ts, f, propType),
                undefined,
            );
            const setter = f.createSetAccessorDeclaration(
                setterModifiers.length ? f.createNodeArray(setterModifiers) : undefined,
                f.createIdentifier(propNameText),
                f.createNodeArray([setterParam]),
                f.createBlock(
                    f.createNodeArray([
                        f.createExpressionStatement(
                            f.createBinaryExpression(
                                f.createPropertyAccessExpression(
                                    f.createThis(),
                                    f.createIdentifier(backingPropId),
                                ),
                                kinds.EqualsToken,
                                f.createIdentifier("value"),
                            ),
                        ),
                    ]),
                    true,
                ),
            );
            ts.setTextRange(setter, { pos: memberStart, end: cursor.getNodePos() });
            members.push(setter);
        }
    }
}

