import { markGenerated } from "@tspp/plugin-sdk";
import type { TSPPSyntaxCursor, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { parseClassBodyMembers } from "./member-parser";

export function createObjectSyntax(ts: TSPPTypeScript): {
    extension: TSPPSyntaxExtension;
    isSingletonObject: (node: TS.Node) => boolean;
} {
    const kinds = ts.SyntaxKind;
    const singletonObjects = new WeakSet<TS.Node>();
    const authoredObjects = new WeakMap<TS.Node, string>();

    const range = <T extends TS.Node | TS.NodeArray<TS.Node>>(node: T, pos: number, end: number): T =>
        ts.setTextRange(node, { pos, end });

    function isObjectStart(cursor: TSPPSyntaxCursor): boolean {
        const isObjToken = cursor.token() === kinds.ObjectKeyword || cursor.tokenText() === "object";
        if (!isObjToken) return false;
        return cursor.lookAhead(() => {
            cursor.nextToken();
            return !cursor.hasPrecedingLineBreak() && cursor.token() === kinds.Identifier;
        });
    }

    function parseObject(cursor: TSPPSyntaxCursor): readonly TS.Statement[] {
        const startPos = cursor.getTokenStart();
        const f = cursor.factory;
        const outerModifiers = cursor.modifiers;
        const isExported = outerModifiers?.some(m => m.kind === kinds.ExportKeyword) ?? false;
        const isDefault = outerModifiers?.some(m => m.kind === kinds.DefaultKeyword) ?? false;

        cursor.nextToken(); // consume 'object'
        const nameNode = cursor.parseIdentifier();
        const nameText = ts.idText(nameNode);

        // Optional heritage clauses: extends / implements
        const heritageClauses: TS.HeritageClause[] = [];
        if (cursor.token() === kinds.ExtendsKeyword) {
            cursor.nextToken();
            const types: TS.ExpressionWithTypeArguments[] = [];
            const expr = cursor.parseExpression() as TS.ExpressionWithTypeArguments;
            types.push(expr);
            heritageClauses.push(f.createHeritageClause(kinds.ExtendsKeyword, f.createNodeArray(types)));
        }
        if (cursor.token() === kinds.ImplementsKeyword) {
            cursor.nextToken();
            const types: TS.ExpressionWithTypeArguments[] = [];
            while (cursor.token() !== kinds.OpenBraceToken && cursor.token() !== kinds.EndOfFileToken) {
                const expr = cursor.parseExpression() as TS.ExpressionWithTypeArguments;
                types.push(expr);
                if (cursor.token() === kinds.CommaToken) cursor.nextToken();
                else break;
            }
            heritageClauses.push(f.createHeritageClause(kinds.ImplementsKeyword, f.createNodeArray(types)));
        }

        // Parse class body: { ... }
        const { members } = parseClassBodyMembers(ts, cursor);
        const endPos = cursor.getNodePos();

        // Build: const Name = new (class Name { ... })();
        const classExpr = range(
            f.createClassExpression(
                /*modifiers*/ undefined,
                range(f.createIdentifier(nameText), nameNode.pos, nameNode.end),
                /*typeParameters*/ undefined,
                heritageClauses.length ? f.createNodeArray(heritageClauses) : undefined,
                f.createNodeArray(members),
            ),
            startPos,
            endPos,
        );

        const newExpr = range(
            f.createNewExpression(f.createParenthesizedExpression(classExpr), /*typeArguments*/ undefined, f.createNodeArray([])),
            startPos,
            endPos,
        );

        const constModifiers: TS.Modifier[] = [];
        if (isExported) constModifiers.push(f.createModifier(kinds.ExportKeyword));
        if (isDefault) constModifiers.push(f.createModifier(kinds.DefaultKeyword));

        const varDecl = f.createVariableDeclaration(
            range(f.createIdentifier(nameText), nameNode.pos, nameNode.end),
            /*exclamationToken*/ undefined,
            /*type*/ undefined,
            newExpr,
        );

        const varStatement = range(
            f.createVariableStatement(
                constModifiers.length ? f.createNodeArray(constModifiers) : undefined,
                f.createVariableDeclarationList([varDecl], ts.NodeFlags.Const),
            ),
            startPos,
            endPos,
        );

        // Type alias: export type Name = typeof Name;
        const typeModifiers = isExported ? [f.createModifier(kinds.ExportKeyword)] : undefined;
        const typeAlias = range(
            f.createTypeAliasDeclaration(
                typeModifiers ? f.createNodeArray(typeModifiers) : undefined,
                range(f.createIdentifier(nameText), nameNode.pos, nameNode.end),
                /*typeParameters*/ undefined,
                range(f.createTypeQueryNode(range(f.createIdentifier(nameText), nameNode.pos, nameNode.end)), nameNode.pos, nameNode.end),
            ),
            startPos,
            endPos,
        );

        singletonObjects.add(varStatement);
        singletonObjects.add(typeAlias);

        const authoredText = `${isExported ? "export " : ""}object ${nameText} { ... }`;
        authoredObjects.set(varStatement, authoredText);

        const after = cursor.getTokenStart();
        return [
            markGenerated(ts, varStatement, after, { pos: startPos, end: endPos }),
            markGenerated(ts, typeAlias, after),
        ];
    }

    const extension: TSPPSyntaxExtension = {
        position: "declaration",
        startTokens: [kinds.Identifier, kinds.ObjectKeyword],
        keywords: ["object"],
        isStart: isObjectStart,
        parse: parseObject,
        restoreDeclaration: statement => authoredObjects.get(statement),
    };

    return {
        extension,
        isSingletonObject: node => singletonObjects.has(node),
    };
}
