import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";
import { recordModifierError } from "./diagnostics";
import {
    blockContainsField as checkBlockContainsField,
    parseFieldProperty,
    replaceFieldInBlock as doReplaceFieldInBlock,
} from "./field-lowering";

export interface ParsedClassMemberResult {
    members: TS.ClassElement[];
    finalMethods: Set<string>;
}

export function parseClassBodyMembers(
    ts: TSPPTypeScript,
    cursor: TSPPSyntaxCursor,
): ParsedClassMemberResult {
    const kinds = ts.SyntaxKind;
    const f = cursor.factory;
    const members: TS.ClassElement[] = [];
    const finalMethods = new Set<string>();
    const addedBackingFields = new Set<string>();

    const blockContainsField = (block: TS.Block): boolean => checkBlockContainsField(ts, block);
    const replaceFieldInBlock = (block: TS.Block, id: string): TS.Block => doReplaceFieldInBlock(ts, f, block, id);

    cursor.parseExpected(kinds.OpenBraceToken);

    while (cursor.token() !== kinds.CloseBraceToken && cursor.token() !== kinds.EndOfFileToken) {
        if (cursor.token() === kinds.SemicolonToken) {
            cursor.nextToken();
            continue;
        }

        const memberStart = cursor.getTokenStart();

        let isGetter = false;
        let isSetter = false;
        let isFinal = false;
        let isField = false;
        let isAsync = false;
        let isStatic = false;
        let isReadonly = false;
        let isAbstract = false;
        let isOverride = false;
        let accessKind: TS.SyntaxKind | undefined = undefined;

        const fileName = cursor.getSourceText();
        const seenMemberModifiers = new Map<string, number>();

        // Unified modifier and contextual keyword loop
        while (true) {
            const token = cursor.token();
            const text = cursor.tokenText();
            const modStart = cursor.getTokenStart();
            const modLen = Math.max(1, cursor.getNodePos() - modStart);

            if (token === kinds.PublicKeyword || token === kinds.PrivateKeyword || token === kinds.ProtectedKeyword) {
                if (accessKind !== undefined) {
                    recordModifierError(fileName, modStart, modLen, "Accessibility modifier already seen.");
                }
                accessKind = token;
                cursor.nextToken();
            } else if (token === kinds.StaticKeyword) {
                if (seenMemberModifiers.has("static")) {
                    recordModifierError(fileName, modStart, modLen, "Duplicate 'static' modifier.");
                }
                isStatic = true;
                seenMemberModifiers.set("static", modStart);
                cursor.nextToken();
            } else if (token === kinds.ReadonlyKeyword) {
                if (seenMemberModifiers.has("readonly")) {
                    recordModifierError(fileName, modStart, modLen, "Duplicate 'readonly' modifier.");
                }
                isReadonly = true;
                seenMemberModifiers.set("readonly", modStart);
                cursor.nextToken();
            } else if (token === kinds.AbstractKeyword) {
                if (seenMemberModifiers.has("abstract")) {
                    recordModifierError(fileName, modStart, modLen, "Duplicate 'abstract' modifier.");
                }
                isAbstract = true;
                seenMemberModifiers.set("abstract", modStart);
                cursor.nextToken();
            } else if (token === kinds.OverrideKeyword) {
                if (seenMemberModifiers.has("override")) {
                    recordModifierError(fileName, modStart, modLen, "Duplicate 'override' modifier.");
                }
                isOverride = true;
                seenMemberModifiers.set("override", modStart);
                cursor.nextToken();
            } else if (token === kinds.AsyncKeyword) {
                if (seenMemberModifiers.has("async")) {
                    recordModifierError(fileName, modStart, modLen, "Duplicate 'async' modifier.");
                }
                isAsync = true;
                seenMemberModifiers.set("async", modStart);
                cursor.nextToken();
            } else if (text === "final") {
                const isModifier = cursor.lookAhead(() => {
                    cursor.nextToken();
                    const next = cursor.token();
                    return next === kinds.Identifier || next === kinds.StringLiteral || next === kinds.NumericLiteral;
                });
                if (!isModifier) break;
                if (seenMemberModifiers.has("final")) {
                    recordModifierError(fileName, modStart, modLen, "Duplicate 'final' modifier.");
                }
                isFinal = true;
                seenMemberModifiers.set("final", modStart);
                cursor.nextToken();
            } else if (text === "field") {
                const isModifier = cursor.lookAhead(() => {
                    cursor.nextToken();
                    const next = cursor.token();
                    return next === kinds.Identifier || next === kinds.StringLiteral || next === kinds.NumericLiteral;
                });
                if (!isModifier) break;
                if (seenMemberModifiers.has("field")) {
                    recordModifierError(fileName, modStart, modLen, "Duplicate 'field' modifier.");
                }
                isField = true;
                seenMemberModifiers.set("field", modStart);
                cursor.nextToken();
            } else if (text === "get" || text === "set") {
                const isAccessor = cursor.lookAhead(() => {
                    cursor.nextToken();
                    const next = cursor.token();
                    return next === kinds.Identifier || next === kinds.StringLiteral || next === kinds.NumericLiteral;
                });
                if (isAccessor) {
                    if (text === "get") isGetter = true;
                    else isSetter = true;
                    cursor.nextToken();
                    break;
                } else {
                    break;
                }
            } else {
                break;
            }
        }

        // Validate member modifier combinations
        if (isFinal && isAbstract) {
            recordModifierError(fileName, memberStart, Math.max(1, cursor.getTokenStart() - memberStart), "Cannot combine 'final' and 'abstract' modifiers on a member.");
        }
        if (isFinal && accessKind === kinds.PrivateKeyword) {
            recordModifierError(fileName, memberStart, Math.max(1, cursor.getTokenStart() - memberStart), "'final' modifier cannot be used with a private modifier.");
        }
        if (isAbstract && accessKind === kinds.PrivateKeyword) {
            recordModifierError(fileName, memberStart, Math.max(1, cursor.getTokenStart() - memberStart), "'abstract' modifier cannot be used with a private modifier.");
        }
        if (isField && isAbstract) {
            recordModifierError(fileName, memberStart, Math.max(1, cursor.getTokenStart() - memberStart), "A field property cannot be 'abstract'.");
        }

        // Check constructor
        if (cursor.token() === kinds.ConstructorKeyword) {
            cursor.nextToken(); // consume 'constructor'
            cursor.parseExpected(kinds.OpenParenToken);
            const params: TS.ParameterDeclaration[] = [];
            while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
                const paramModifiers: TS.Modifier[] = [];
                while (
                    cursor.token() === kinds.PublicKeyword ||
                    cursor.token() === kinds.PrivateKeyword ||
                    cursor.token() === kinds.ProtectedKeyword ||
                    cursor.token() === kinds.ReadonlyKeyword
                ) {
                    paramModifiers.push(f.createModifier(cursor.token() as any));
                    cursor.nextToken();
                }
                const paramName = cursor.parseIdentifier();
                let paramType: TS.TypeNode | undefined;
                if (cursor.token() === kinds.ColonToken) {
                    cursor.nextToken();
                    paramType = cursor.parseType();
                }
                let paramInit: TS.Expression | undefined;
                if (cursor.token() === kinds.EqualsToken) {
                    cursor.nextToken();
                    paramInit = cursor.parseAssignmentExpression();
                }
                params.push(
                    f.createParameterDeclaration(
                        paramModifiers.length ? f.createNodeArray(paramModifiers) : undefined,
                        undefined,
                        paramName,
                        undefined,
                        paramType,
                        paramInit,
                    ),
                );
                if (cursor.token() === kinds.CommaToken) cursor.nextToken();
                else break;
            }
            cursor.parseExpected(kinds.CloseParenToken);
            const body = cursor.parseStatement() as TS.Block;

            const ctorModifiers: TS.Modifier[] = [];
            if (accessKind) ctorModifiers.push(f.createModifier(accessKind as any));
            const constructorDecl = f.createConstructorDeclaration(
                ctorModifiers.length ? f.createNodeArray(ctorModifiers) : undefined,
                f.createNodeArray(params),
                body,
            );
            ts.setTextRange(constructorDecl, { pos: memberStart, end: cursor.getNodePos() });
            members.push(constructorDecl);
            continue;
        }

        // Check field property: `field count: number = 0 { get() { ... } set(v) { ... } }`
        if (isField) {
            parseFieldProperty({
                ts,
                cursor,
                memberStart,
                accessKind,
                isStatic,
                isReadonly,
                isOverride,
                addedBackingFields,
                members,
            });
            continue;
        }

        const memberName = cursor.parseIdentifier();
        const memberNameText = ts.idText(memberName);
        if (isFinal) {
            finalMethods.add(memberNameText);
        }

        // Build member modifiers
        const memberModifiers: TS.Modifier[] = [];
        if (accessKind) memberModifiers.push(f.createModifier(accessKind as any));
        if (isStatic) memberModifiers.push(f.createModifier(kinds.StaticKeyword));
        if (isReadonly) memberModifiers.push(f.createModifier(kinds.ReadonlyKeyword));
        if (isAbstract) memberModifiers.push(f.createModifier(kinds.AbstractKeyword));
        if (isOverride) memberModifiers.push(f.createModifier(kinds.OverrideKeyword));
        if (isAsync) memberModifiers.push(f.createModifier(kinds.AsyncKeyword));

        // Getter accessor: `get count(): number { ... }`
        if (isGetter) {
            cursor.parseExpected(kinds.OpenParenToken);
            cursor.parseExpected(kinds.CloseParenToken);
            let returnType: TS.TypeNode | undefined;
            if (cursor.token() === kinds.ColonToken) {
                cursor.nextToken();
                returnType = cursor.parseType();
            }
            const rawBody = cursor.parseStatement() as TS.Block;
            const backingPropId = `__field_${memberNameText}`;
            let body = rawBody;

            if (blockContainsField(rawBody)) {
                if (!addedBackingFields.has(backingPropId)) {
                    addedBackingFields.add(backingPropId);
                    const backingModifiers: TS.Modifier[] = [f.createModifier(kinds.PrivateKeyword)];
                    if (isStatic) backingModifiers.push(f.createModifier(kinds.StaticKeyword));
                    const backingProp = f.createPropertyDeclaration(
                        f.createNodeArray(backingModifiers),
                        f.createIdentifier(backingPropId),
                        f.createToken(kinds.ExclamationToken),
                        returnType,
                        undefined,
                    );
                    ts.setTextRange(backingProp, { pos: memberStart, end: cursor.getNodePos() });
                    members.push(backingProp);
                }
                body = replaceFieldInBlock(rawBody, backingPropId);
            }

            const getterDecl = f.createGetAccessorDeclaration(
                memberModifiers.length ? f.createNodeArray(memberModifiers) : undefined,
                memberName,
                f.createNodeArray([]),
                returnType,
                body,
            );
            ts.setTextRange(getterDecl, { pos: memberStart, end: cursor.getNodePos() });
            members.push(getterDecl);
            continue;
        }

        // Setter accessor: `set count(v: number) { ... }`
        if (isSetter) {
            cursor.parseExpected(kinds.OpenParenToken);
            const paramName = cursor.parseIdentifier();
            let paramType: TS.TypeNode | undefined;
            if (cursor.token() === kinds.ColonToken) {
                cursor.nextToken();
                paramType = cursor.parseType();
            }
            cursor.parseExpected(kinds.CloseParenToken);
            const rawBody = cursor.parseStatement() as TS.Block;
            const backingPropId = `__field_${memberNameText}`;
            let body = rawBody;

            if (blockContainsField(rawBody)) {
                if (!addedBackingFields.has(backingPropId)) {
                    addedBackingFields.add(backingPropId);
                    const backingModifiers: TS.Modifier[] = [f.createModifier(kinds.PrivateKeyword)];
                    if (isStatic) backingModifiers.push(f.createModifier(kinds.StaticKeyword));
                    const backingProp = f.createPropertyDeclaration(
                        f.createNodeArray(backingModifiers),
                        f.createIdentifier(backingPropId),
                        f.createToken(kinds.ExclamationToken),
                        paramType,
                        undefined,
                    );
                    ts.setTextRange(backingProp, { pos: memberStart, end: cursor.getNodePos() });
                    members.push(backingProp);
                }
                body = replaceFieldInBlock(rawBody, backingPropId);
            }

            const setterDecl = f.createSetAccessorDeclaration(
                memberModifiers.length ? f.createNodeArray(memberModifiers) : undefined,
                memberName,
                f.createNodeArray([f.createParameterDeclaration(undefined, undefined, paramName, undefined, paramType, undefined)]),
                body,
            );
            ts.setTextRange(setterDecl, { pos: memberStart, end: cursor.getNodePos() });
            members.push(setterDecl);
            continue;
        }

        // Method: `inc(): number { ... }`
        if (cursor.token() === kinds.OpenParenToken) {
            cursor.nextToken();
            const params: TS.ParameterDeclaration[] = [];
            while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
                const paramModifiers: TS.Modifier[] = [];
                while (
                    cursor.token() === kinds.PublicKeyword ||
                    cursor.token() === kinds.PrivateKeyword ||
                    cursor.token() === kinds.ProtectedKeyword ||
                    cursor.token() === kinds.ReadonlyKeyword
                ) {
                    paramModifiers.push(f.createModifier(cursor.token() as any));
                    cursor.nextToken();
                }
                const paramName = cursor.parseIdentifier();
                let paramType: TS.TypeNode | undefined;
                if (cursor.token() === kinds.ColonToken) {
                    cursor.nextToken();
                    paramType = cursor.parseType();
                }
                let paramInit: TS.Expression | undefined;
                if (cursor.token() === kinds.EqualsToken) {
                    cursor.nextToken();
                    paramInit = cursor.parseAssignmentExpression();
                }
                params.push(
                    f.createParameterDeclaration(
                        paramModifiers.length ? f.createNodeArray(paramModifiers) : undefined,
                        undefined,
                        paramName,
                        undefined,
                        paramType,
                        paramInit,
                    ),
                );
                if (cursor.token() === kinds.CommaToken) cursor.nextToken();
                else break;
            }
            cursor.parseExpected(kinds.CloseParenToken);

            let returnType: TS.TypeNode | undefined;
            if (cursor.token() === kinds.ColonToken) {
                cursor.nextToken();
                returnType = cursor.parseType();
            }

            let body: TS.Block | undefined;
            if (cursor.token() === kinds.OpenBraceToken) {
                body = cursor.parseStatement() as TS.Block;
            } else {
                cursor.parseOptional(kinds.SemicolonToken);
            }
            const methodDecl = f.createMethodDeclaration(
                memberModifiers.length ? f.createNodeArray(memberModifiers) : undefined,
                undefined,
                memberName,
                undefined,
                undefined,
                f.createNodeArray(params),
                returnType,
                body,
            );
            ts.setTextRange(methodDecl, { pos: memberStart, end: cursor.getNodePos() });
            members.push(methodDecl);
        } else {
            // Property: `count = 0;` or `count: number = 0;`
            let propType: TS.TypeNode | undefined;
            if (cursor.token() === kinds.ColonToken) {
                cursor.nextToken();
                propType = cursor.parseType();
            }
            let initializer: TS.Expression | undefined;
            if (cursor.token() === kinds.EqualsToken) {
                cursor.nextToken();
                initializer = cursor.parseAssignmentExpression();
            }
            cursor.parseOptional(kinds.SemicolonToken);

            const propDecl = f.createPropertyDeclaration(
                memberModifiers.length ? f.createNodeArray(memberModifiers) : undefined,
                memberName,
                undefined,
                propType,
                initializer,
            );
            ts.setTextRange(propDecl, { pos: memberStart, end: cursor.getNodePos() });
            members.push(propDecl);
        }
    }

    cursor.parseExpected(kinds.CloseBraceToken);
    return { members, finalMethods };
}
