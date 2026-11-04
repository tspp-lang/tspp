import { markGenerated } from "@tspp/plugin-sdk";
import type {
    TSPPSourcePreprocessor,
    TSPPSyntaxCursor,
    TSPPSyntaxExtension,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { parseClassBodyMembers } from "./member-parser";
import { recordModifierError } from "./diagnostics";

export interface DataClassProperty {
    name: string;
    type?: TS.TypeNode;
    initializer?: TS.Expression;
    isReadonly: boolean;
}

export interface AdvancedClassInfo {
    name: string;
    fileName: string;
    isFinal: boolean;
    isSealed: boolean;
    isData: boolean;
    subclasses: string[];
    finalMethods: Set<string>;
    dataProperties?: DataClassProperty[];
}

export function createAdvancedClassDeclarations(ts: TSPPTypeScript): {
    extension: TSPPSyntaxExtension;
    getClassInfo: (className: string) => AdvancedClassInfo | undefined;
    getAllClasses: () => ReadonlyMap<string, AdvancedClassInfo>;
    finalClasses: Set<string>;
    sealedClasses: Map<string, string>; // className -> declaringFileText
    finalMethodsByClass: Map<string, Set<string>>;
} {
    const kinds = ts.SyntaxKind;
    const classRegistry = new Map<string, AdvancedClassInfo>();
    const finalClasses = new Set<string>();
    const sealedClasses = new Map<string, string>();
    const finalMethodsByClass = new Map<string, Set<string>>();
    const authoredDeclarations = new WeakMap<TS.Node, string>();

    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T =>
        ts.setTextRange(node, { pos, end });

    function isAdvancedClassStart(cursor: TSPPSyntaxCursor): boolean {
        const text = cursor.tokenText();
        if (text === "final" || text === "sealed") {
            return cursor.lookAhead(() => {
                cursor.nextToken();
                if (cursor.hasPrecedingLineBreak()) return false;
                const next = cursor.tokenText();
                if (next === "class" || next === "abstract" || next === "data" || next === "sealed" || next === "final") return true;
                return cursor.token() === kinds.ClassKeyword || cursor.token() === kinds.AbstractKeyword;
            });
        }
        if (text === "data") {
            return cursor.lookAhead(() => {
                cursor.nextToken();
                if (cursor.hasPrecedingLineBreak()) return false;
                return cursor.token() === kinds.ClassKeyword;
            });
        }
        if (cursor.token() === kinds.AbstractKeyword || text === "abstract") {
            return cursor.lookAhead(() => {
                cursor.nextToken();
                if (cursor.hasPrecedingLineBreak()) return false;
                const next = cursor.tokenText();
                return next === "final" || next === "sealed" || next === "data" || next === "class" || cursor.token() === kinds.ClassKeyword;
            });
        }
        if (cursor.token() === kinds.ClassKeyword) {
            return cursor.lookAhead(() => {
                cursor.nextToken(); // consume 'class'
                if (cursor.token() === kinds.Identifier) cursor.nextToken();
                // skip type parameters
                if (cursor.token() === kinds.LessThanToken) {
                    let depth = 1;
                    cursor.nextToken();
                    while (depth > 0 && cursor.token() !== kinds.EndOfFileToken) {
                        if (cursor.token() === kinds.LessThanToken) depth++;
                        else if (cursor.token() === kinds.GreaterThanToken) depth--;
                        cursor.nextToken();
                    }
                }
                // skip until '{'
                while (cursor.token() !== kinds.OpenBraceToken && cursor.token() !== kinds.EndOfFileToken) {
                    cursor.nextToken();
                }
                if (cursor.token() !== kinds.OpenBraceToken) return false;
                cursor.nextToken();
                let depth = 1;
                while (depth > 0 && cursor.token() !== kinds.EndOfFileToken) {
                    if (depth === 1 && (cursor.tokenText() === "field" || cursor.tokenText() === "final")) {
                        const isModifier = cursor.lookAhead(() => {
                            cursor.nextToken();
                            const next = cursor.token();
                            return next === kinds.Identifier || next === kinds.StringLiteral || next === kinds.NumericLiteral;
                        });
                        if (isModifier) return true;
                    } else if (depth > 1 && cursor.tokenText() === "field") {
                        return true;
                    }
                    if (cursor.token() === kinds.OpenBraceToken) depth++;
                    else if (cursor.token() === kinds.CloseBraceToken) depth--;
                    cursor.nextToken();
                }
                return false;
            });
        }
        return false;
    }

    function parseAdvancedClass(cursor: TSPPSyntaxCursor): TS.Statement {
        const startPos = cursor.getTokenStart();
        const f = cursor.factory;
        const outerModifiers = cursor.modifiers ? [...cursor.modifiers] : [];

        let isFinal = false;
        let isSealed = false;
        let isData = false;
        let isAbstract = false;

        const seenModifiers = new Map<string, { start: number; length: number }>();
        const fileName = cursor.getSourceText();

        // Consume modifiers: final, sealed, data, abstract
        while (cursor.token() !== kinds.EndOfFileToken) {
            const tokenText = cursor.tokenText();
            const tokenStart = cursor.getTokenStart();
            const tokenLen = Math.max(1, cursor.getNodePos() - tokenStart);

            if (tokenText === "final") {
                if (seenModifiers.has("final")) {
                    recordModifierError(fileName, tokenStart, tokenLen, "Duplicate 'final' modifier.");
                }
                isFinal = true;
                seenModifiers.set("final", { start: tokenStart, length: tokenLen });
                cursor.nextToken();
            } else if (tokenText === "sealed") {
                if (seenModifiers.has("sealed")) {
                    recordModifierError(fileName, tokenStart, tokenLen, "Duplicate 'sealed' modifier.");
                }
                isSealed = true;
                seenModifiers.set("sealed", { start: tokenStart, length: tokenLen });
                cursor.nextToken();
            } else if (tokenText === "data") {
                if (seenModifiers.has("data")) {
                    recordModifierError(fileName, tokenStart, tokenLen, "Duplicate 'data' modifier.");
                }
                isData = true;
                seenModifiers.set("data", { start: tokenStart, length: tokenLen });
                cursor.nextToken();
            } else if (cursor.token() === kinds.AbstractKeyword) {
                if (seenModifiers.has("abstract")) {
                    recordModifierError(fileName, tokenStart, tokenLen, "Duplicate 'abstract' modifier.");
                }
                isAbstract = true;
                seenModifiers.set("abstract", { start: tokenStart, length: tokenLen });
                cursor.nextToken();
            } else {
                break;
            }
        }

        // Validate mutually exclusive class modifiers
        if (isFinal && isAbstract) {
            recordModifierError(fileName, startPos, Math.max(1, cursor.getTokenStart() - startPos), "Cannot combine 'final' and 'abstract' modifiers on a class.");
        }
        if (isFinal && isSealed) {
            recordModifierError(fileName, startPos, Math.max(1, cursor.getTokenStart() - startPos), "Cannot combine 'final' and 'sealed' modifiers on a class.");
        }
        if (isData && isAbstract) {
            recordModifierError(fileName, startPos, Math.max(1, cursor.getTokenStart() - startPos), "A data class cannot be 'abstract'.");
        }
        if (isData && isSealed) {
            recordModifierError(fileName, startPos, Math.max(1, cursor.getTokenStart() - startPos), "A data class cannot be 'sealed'.");
        }
        if (isData && isFinal) {
            recordModifierError(fileName, startPos, Math.max(1, cursor.getTokenStart() - startPos), "A data class cannot be 'final'.");
        }

        // Expected 'class'
        cursor.parseExpected(kinds.ClassKeyword);
        const nameNode = cursor.parseIdentifier();
        const className = ts.idText(nameNode);

        // Optional type parameters <T, U>
        let typeParameters: TS.NodeArray<TS.TypeParameterDeclaration> | undefined;
        if (cursor.token() === kinds.LessThanToken) {
            typeParameters = cursor.parseTypeParameters();
        }

        // Check if there is a primary constructor: (param: type, ...)
        const dataProperties: DataClassProperty[] = [];
        if (cursor.token() === kinds.OpenParenToken) {
            cursor.nextToken(); // consume '('
            while (cursor.token() !== kinds.CloseParenToken && cursor.token() !== kinds.EndOfFileToken) {
                let isPropReadonly = true;
                if (cursor.tokenText() === "val" || cursor.tokenText() === "readonly") {
                    isPropReadonly = true;
                    cursor.nextToken();
                } else if (cursor.tokenText() === "var") {
                    isPropReadonly = false;
                    cursor.nextToken();
                }

                const paramNameNode = cursor.parseIdentifier();
                const paramName = ts.idText(paramNameNode);
                let paramType: TS.TypeNode | undefined;
                if (cursor.token() === kinds.ColonToken) {
                    cursor.nextToken();
                    paramType = cursor.parseType();
                }

                let initializer: TS.Expression | undefined;
                if (cursor.token() === kinds.EqualsToken) {
                    cursor.nextToken();
                    initializer = cursor.parseAssignmentExpression();
                }

                dataProperties.push({
                    name: paramName,
                    type: paramType,
                    initializer,
                    isReadonly: isPropReadonly,
                });

                if (cursor.token() === kinds.CommaToken) cursor.nextToken();
                else break;
            }
            cursor.parseExpected(kinds.CloseParenToken);
            isData = true; // Classes with primary constructor parameters act as data classes
        }

        // Heritage clauses: extends, implements
        const heritageClauses: TS.HeritageClause[] = [];
        let extendsBaseName: string | undefined;

        if (cursor.token() === kinds.ExtendsKeyword) {
            const clauseStart = cursor.getTokenStart();
            cursor.nextToken();
            const types: TS.ExpressionWithTypeArguments[] = [];
            while (cursor.token() !== kinds.OpenBraceToken && cursor.token() !== kinds.ImplementsKeyword && cursor.token() !== kinds.EndOfFileToken && !cursor.hasPrecedingLineBreak()) {
                const exprStart = cursor.getTokenStart();
                const expr = cursor.parseExpression();
                if (ts.isIdentifier(expr)) extendsBaseName = ts.idText(expr);
                let typeArgs: TS.NodeArray<TS.TypeNode> | undefined;
                if (cursor.token() === kinds.LessThanToken) {
                    typeArgs = cursor.parseTypeArguments();
                }
                const exprWithTypeArgs = f.createExpressionWithTypeArguments(expr, typeArgs);
                ts.setTextRange(exprWithTypeArgs, { pos: exprStart, end: cursor.getNodePos() });
                types.push(exprWithTypeArgs);
                if (cursor.token() === kinds.CommaToken) cursor.nextToken();
                else break;
            }
            const clause = f.createHeritageClause(kinds.ExtendsKeyword, f.createNodeArray(types));
            ts.setTextRange(clause, { pos: clauseStart, end: cursor.getNodePos() });
            heritageClauses.push(clause);
        }

        if (cursor.token() === kinds.ImplementsKeyword) {
            const clauseStart = cursor.getTokenStart();
            cursor.nextToken();
            const types: TS.ExpressionWithTypeArguments[] = [];
            while (cursor.token() !== kinds.OpenBraceToken && cursor.token() !== kinds.EndOfFileToken && !cursor.hasPrecedingLineBreak()) {
                const exprStart = cursor.getTokenStart();
                const expr = cursor.parseExpression();
                let typeArgs: TS.NodeArray<TS.TypeNode> | undefined;
                if (cursor.token() === kinds.LessThanToken) {
                    typeArgs = cursor.parseTypeArguments();
                }
                const exprWithTypeArgs = f.createExpressionWithTypeArguments(expr, typeArgs);
                ts.setTextRange(exprWithTypeArgs, { pos: exprStart, end: cursor.getNodePos() });
                types.push(exprWithTypeArgs);
                if (cursor.token() === kinds.CommaToken) cursor.nextToken();
                else break;
            }
            const clause = f.createHeritageClause(kinds.ImplementsKeyword, f.createNodeArray(types));
            ts.setTextRange(clause, { pos: clauseStart, end: cursor.getNodePos() });
            heritageClauses.push(clause);
        }

        // Parse optional body: { ... }
        let userMembers: TS.ClassElement[] = [];
        let finalMethods = new Set<string>();

        if (cursor.token() === kinds.OpenBraceToken) {
            const parsed = parseClassBodyMembers(ts, cursor);
            userMembers = parsed.members;
            finalMethods = parsed.finalMethods;
        } else {
            cursor.parseOptional(kinds.SemicolonToken);
        }

        const endPos = cursor.getNodePos();

        // Synthesize data class members if isData
        const synthesizedMembers: TS.ClassElement[] = [];
        if (isData && dataProperties.length > 0) {
            // 1. Properties
            for (const prop of dataProperties) {
                const propModifiers: TS.Modifier[] = [f.createModifier(kinds.PublicKeyword)];
                if (prop.isReadonly) propModifiers.push(f.createModifier(kinds.ReadonlyKeyword));
                synthesizedMembers.push(
                    f.createPropertyDeclaration(
                        f.createNodeArray(propModifiers),
                        f.createIdentifier(prop.name),
                        /*questionOrExclamationToken*/ undefined,
                        prop.type,
                        /*initializer*/ undefined,
                    ),
                );
            }

            // 2. Constructor
            const constructorParams: TS.ParameterDeclaration[] = dataProperties.map(prop =>
                f.createParameterDeclaration(
                    /*modifiers*/ undefined,
                    /*dotDotDotToken*/ undefined,
                    f.createIdentifier(prop.name),
                    /*questionToken*/ undefined,
                    prop.type,
                    prop.initializer,
                )
            );

            const constructorStatements: TS.Statement[] = [];
            if (extendsBaseName) {
                constructorStatements.push(
                    f.createExpressionStatement(f.createCallExpression(f.createSuper(), undefined, f.createNodeArray([]))),
                );
            }
            for (const prop of dataProperties) {
                constructorStatements.push(
                    f.createExpressionStatement(
                        f.createBinaryExpression(
                            f.createPropertyAccessExpression(f.createThis(), f.createIdentifier(prop.name)),
                            f.createToken(kinds.EqualsToken),
                            f.createIdentifier(prop.name),
                        ),
                    ),
                );
            }

            synthesizedMembers.push(
                f.createConstructorDeclaration(
                    /*modifiers*/ undefined,
                    f.createNodeArray(constructorParams),
                    f.createBlock(f.createNodeArray(constructorStatements), /*multiLine*/ true),
                ),
            );

            // 3. copy(patch?: { prop?: type, ... }): ClassName
            const patchParam = f.createParameterDeclaration(
                undefined,
                undefined,
                f.createIdentifier("patch"),
                f.createToken(kinds.QuestionToken),
                f.createTypeLiteralNode(
                    f.createNodeArray(dataProperties.map(p =>
                        f.createPropertySignature(
                            undefined,
                            f.createIdentifier(p.name),
                            f.createToken(kinds.QuestionToken),
                            p.type,
                        )
                    )),
                ),
                undefined,
            );

            const copyArgs = dataProperties.map(prop =>
                f.createConditionalExpression(
                    f.createBinaryExpression(
                        f.createIdentifier("patch"),
                        kinds.AmpersandAmpersandToken,
                        f.createBinaryExpression(
                            f.createStringLiteral(prop.name),
                            kinds.InKeyword,
                            f.createIdentifier("patch"),
                        ),
                    ),
                    f.createToken(kinds.QuestionToken),
                    f.createNonNullExpression(
                        f.createPropertyAccessExpression(
                            f.createIdentifier("patch") as unknown as TS.PropertyAccessExpression["expression"],
                            f.createIdentifier(prop.name),
                        ),
                    ),
                    f.createToken(kinds.ColonToken),
                    f.createPropertyAccessExpression(f.createThis(), f.createIdentifier(prop.name)),
                )
            );

            synthesizedMembers.push(
                f.createMethodDeclaration(
                    f.createNodeArray([f.createModifier(kinds.PublicKeyword)]),
                    undefined,
                    f.createIdentifier("copy"),
                    undefined,
                    undefined,
                    f.createNodeArray([patchParam]),
                    f.createTypeReferenceNode(f.createIdentifier(className), undefined),
                    f.createBlock(f.createNodeArray([
                        f.createReturnStatement(
                            f.createNewExpression(f.createIdentifier(className), undefined, f.createNodeArray(copyArgs)),
                        ),
                    ]), true),
                ),
            );

            // 4. equals(other: unknown): boolean
            let equalsExpr: TS.Expression = f.createBinaryExpression(
                f.createIdentifier("other"),
                kinds.InstanceOfKeyword,
                f.createIdentifier(className),
            );
            for (const prop of dataProperties) {
                const propEqual = f.createBinaryExpression(
                    f.createPropertyAccessExpression(f.createThis(), f.createIdentifier(prop.name)),
                    kinds.EqualsEqualsEqualsToken,
                    f.createPropertyAccessExpression(
                        f.createParenthesizedExpression(
                            f.createAsExpression(
                                f.createIdentifier("other"),
                                f.createTypeReferenceNode(f.createIdentifier(className), undefined),
                            ),
                        ),
                        f.createIdentifier(prop.name),
                    ),
                );
                equalsExpr = f.createBinaryExpression(equalsExpr, kinds.AmpersandAmpersandToken, propEqual);
            }

            synthesizedMembers.push(
                f.createMethodDeclaration(
                    f.createNodeArray([f.createModifier(kinds.PublicKeyword)]),
                    undefined,
                    f.createIdentifier("equals"),
                    undefined,
                    undefined,
                    f.createNodeArray([f.createParameterDeclaration(undefined, undefined, f.createIdentifier("other"), undefined, f.createKeywordTypeNode(kinds.UnknownKeyword))]),
                    f.createKeywordTypeNode(kinds.BooleanKeyword),
                    f.createBlock(f.createNodeArray([f.createReturnStatement(equalsExpr)]), true),
                ),
            );

            // 5. toString(): string - "${className}(x=" + this.x + ", y=" + this.y + ")"
            let strExpr: TS.Expression = f.createStringLiteral(`${className}(`);
            for (let i = 0; i < dataProperties.length; i++) {
                const prop = dataProperties[i];
                if (i > 0) {
                    strExpr = f.createBinaryExpression(strExpr, kinds.PlusToken, f.createStringLiteral(", "));
                }
                strExpr = f.createBinaryExpression(strExpr, kinds.PlusToken, f.createStringLiteral(`${prop.name}=`));
                strExpr = f.createBinaryExpression(
                    strExpr,
                    kinds.PlusToken,
                    f.createPropertyAccessExpression(f.createThis(), f.createIdentifier(prop.name)),
                );
            }
            strExpr = f.createBinaryExpression(strExpr, kinds.PlusToken, f.createStringLiteral(")"));

            synthesizedMembers.push(
                f.createMethodDeclaration(
                    f.createNodeArray([f.createModifier(kinds.PublicKeyword)]),
                    undefined,
                    f.createIdentifier("toString"),
                    undefined,
                    undefined,
                    f.createNodeArray([]),
                    f.createKeywordTypeNode(kinds.StringKeyword),
                    f.createBlock(f.createNodeArray([f.createReturnStatement(strExpr)]), true),
                ),
            );
        }

        const allMembers = [...synthesizedMembers, ...userMembers];
        const classModifiers = [...outerModifiers];
        if (isAbstract) classModifiers.push(f.createModifier(kinds.AbstractKeyword));

        const classDeclaration = range(
            f.createClassDeclaration(
                classModifiers.length ? f.createNodeArray(classModifiers) : undefined,
                nameNode,
                typeParameters,
                heritageClauses.length ? f.createNodeArray(heritageClauses) : undefined,
                f.createNodeArray(allMembers),
            ),
            startPos,
            endPos,
        );

        // Record in registry
        const info: AdvancedClassInfo = {
            name: className,
            fileName,
            isFinal,
            isSealed,
            isData,
            subclasses: [],
            finalMethods,
            dataProperties: isData ? dataProperties : undefined,
        };
        classRegistry.set(className, info);
        if (isFinal) finalClasses.add(className);
        if (isSealed) sealedClasses.set(className, fileName);
        if (finalMethods.size > 0) finalMethodsByClass.set(className, finalMethods);

        const prefix = `${isFinal ? "final " : ""}${isSealed ? "sealed " : ""}${isData ? "data " : ""}${isAbstract ? "abstract " : ""}`;
        authoredDeclarations.set(classDeclaration, `${prefix}class ${className}`);

        const after = cursor.getTokenStart();
        return markGenerated(ts, classDeclaration, after, { pos: startPos, end: endPos });
    }

    const extension: TSPPSyntaxExtension = {
        position: "declaration",
        startTokens: [kinds.Identifier, kinds.ClassKeyword, kinds.AbstractKeyword],
        keywords: ["final", "sealed"],
        isStart: isAdvancedClassStart,
        parse: parseAdvancedClass,
        restoreDeclaration: node => authoredDeclarations.get(node),
    };

    return {
        extension,
        getClassInfo: name => classRegistry.get(name),
        getAllClasses: () => classRegistry,
        finalClasses,
        sealedClasses,
        finalMethodsByClass,
    };
}
