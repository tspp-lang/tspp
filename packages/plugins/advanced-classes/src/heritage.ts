import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/**
 * One type of a heritage clause, without its type arguments. A name is read as a name: as an expression, `Base<T> {`
 * would compare `Base` with `T`. Anything else is read as one expression, never a comma list.
 */
function parseHeritageExpression(ts: TSPPTypeScript, cursor: TSPPSyntaxCursor): TS.Expression {
    const kinds = ts.SyntaxKind;
    const isName = cursor.lookAhead(() => {
        if (cursor.token() !== kinds.Identifier) return false;
        cursor.nextToken();
        while (cursor.token() === kinds.DotToken) {
            cursor.nextToken();
            if (cursor.token() !== kinds.Identifier) return false;
            cursor.nextToken();
        }
        const next = cursor.token();
        return next === kinds.LessThanToken || next === kinds.CommaToken || next === kinds.OpenBraceToken || next === kinds.ImplementsKeyword
            || next === kinds.SemicolonToken || next === kinds.EndOfFileToken || cursor.hasPrecedingLineBreak();
    });
    if (!isName) return cursor.parseAssignmentExpression();
    let expression: TS.Expression = cursor.parseIdentifier();
    while (cursor.token() === kinds.DotToken) {
        cursor.nextToken();
        const name = cursor.parseIdentifier();
        expression = ts.setTextRange(cursor.factory.createPropertyAccessExpression(expression, name), { pos: expression.pos, end: name.end });
    }
    return expression;
}

const typeArgumentCopies = new WeakMap<TS.Node, TS.NodeArray<TS.TypeNode>>();

/** A copy of the type arguments of a heritage type, parsed apart from them and without source positions. */
export function getTypeArgumentCopies(type: TS.ExpressionWithTypeArguments): TS.NodeArray<TS.TypeNode> | undefined {
    return typeArgumentCopies.get(type);
}

/** Takes the positions off `nodes`, so that services skip them and errors in them belong to the written original. */
function copyWithoutPositions<T extends TS.Node | TS.NodeArray<TS.Node>>(ts: TSPPTypeScript, nodes: T): T {
    const strip = (node: TS.Node | TS.NodeArray<TS.Node>) => ts.setTextRange(node, { pos: -1, end: -1 });
    const visit = (node: TS.Node): void => {
        strip(node);
        ts.forEachChild(node, visit, children => {
            strip(children);
            children.forEach(visit);
        });
    };
    if (Array.isArray(nodes)) {
        strip(nodes as TS.NodeArray<TS.Node>);
        (nodes as TS.NodeArray<TS.Node>).forEach(visit);
    }
    else visit(nodes as TS.Node);
    return nodes;
}

/** The types of the heritage clause at `extends` or `implements`, which may continue on later lines. */
export function parseHeritageTypes(ts: TSPPTypeScript, cursor: TSPPSyntaxCursor): TS.ExpressionWithTypeArguments[] {
    const kinds = ts.SyntaxKind;
    cursor.nextToken();
    const types: TS.ExpressionWithTypeArguments[] = [];
    while (cursor.token() !== kinds.OpenBraceToken && cursor.token() !== kinds.ImplementsKeyword && cursor.token() !== kinds.EndOfFileToken) {
        const start = cursor.getTokenStart();
        let expression = parseHeritageExpression(ts, cursor);
        let typeArguments: TS.NodeArray<TS.TypeNode> | undefined;
        // Followed by a comma, `Base<T>` parses as an instantiation expression.
        if (ts.isExpressionWithTypeArguments(expression)) {
            typeArguments = expression.typeArguments;
            expression = expression.expression;
        }
        // Only a written name, never an instantiation expression, can be one of several bases.
        let copies: TS.NodeArray<TS.TypeNode> | undefined;
        if (cursor.token() === kinds.LessThanToken) {
            // The same text parsed twice gives a second tree, which generated declarations can hold beside the written one.
            copies = cursor.lookAhead(() => cursor.parseTypeArguments());
            if (copies) copyWithoutPositions(ts, copies);
            typeArguments = cursor.parseTypeArguments();
        }
        const type = ts.setTextRange(cursor.factory.createExpressionWithTypeArguments(expression as TS.LeftHandSideExpression, typeArguments), { pos: start, end: cursor.getNodePos() });
        if (copies) typeArgumentCopies.set(type, copies);
        types.push(type);
        if (!cursor.parseOptional(kinds.CommaToken)) break;
    }
    return types;
}
