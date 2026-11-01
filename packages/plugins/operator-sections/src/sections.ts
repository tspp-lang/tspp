import type { TSPPExpressionRewriter, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

const placeholder = "_";

/**
 * Rewrites `(_ + 1)` and `f(_ * 2)` into arrow functions with one parameter per placeholder, left to right. Each
 * placeholder becomes a reference to its parameter, and both keep the placeholder's source position so that hover
 * and diagnostics point at the `_` the author wrote.
 */
export function createOperatorSectionRewriter(ts: TSPPTypeScript): TSPPExpressionRewriter {
    // Functions, classes, and bindings introduce their own scope or name, so a `_` inside them is not a hole here.
    const opaqueKinds = new Set<TS.SyntaxKind>([
        ts.SyntaxKind.ArrowFunction,
        ts.SyntaxKind.FunctionExpression,
        ts.SyntaxKind.FunctionDeclaration,
        ts.SyntaxKind.ClassExpression,
        ts.SyntaxKind.ClassDeclaration,
        ts.SyntaxKind.MethodDeclaration,
        ts.SyntaxKind.GetAccessor,
        ts.SyntaxKind.SetAccessor,
        ts.SyntaxKind.PropertyAssignment,
        ts.SyntaxKind.ShorthandPropertyAssignment,
        ts.SyntaxKind.Parameter,
        ts.SyntaxKind.VariableDeclaration,
        ts.SyntaxKind.BindingElement,
    ]);

    function collectHoles(node: TS.Node, holes: TS.Identifier[]): void {
        // `idText`, not `.text`: identifiers from the bare compiler (`tsc`) have no `text` accessor.
        if (ts.isIdentifier(node) && ts.idText(node) === placeholder) {
            holes.push(node);
            return;
        }
        if (opaqueKinds.has(node.kind)) return;
        // Only the object of `_.name` can be a hole; the property name is not a reference.
        if (ts.isPropertyAccessExpression(node)) return collectHoles(node.expression, holes);
        ts.forEachChild(node, child => collectHoles(child, holes));
    }

    return {
        rewrite(expression, { factory, parenthesized, pos, end }) {
            // A parenthesized argument was already offered as its inner expression.
            if (!parenthesized && ts.isParenthesizedExpression(expression)) return undefined;
            const holes: TS.Identifier[] = [];
            collectHoles(expression, holes);
            if (!holes.length) return undefined;
            const parameters = holes.map((hole, index) => {
                const name = ts.setTextRange(factory.createIdentifier(`__p${index}`), hole);
                (hole as { escapedText: TS.__String; }).escapedText = name.escapedText;
                return ts.setTextRange(
                    factory.createParameterDeclaration(/*modifiers*/ undefined, /*dotDotDotToken*/ undefined, name),
                    hole,
                );
            });
            const arrow = ts.setTextRange(
                factory.createArrowFunction(
                    /*modifiers*/ undefined,
                    /*typeParameters*/ undefined,
                    ts.setTextRange(factory.createNodeArray(parameters), { pos, end: pos }),
                    /*type*/ undefined,
                    ts.setTextRange(factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), { pos, end: pos }),
                    expression,
                ),
                { pos, end },
            );
            return ts.setTextRange(factory.createParenthesizedExpression(arrow), { pos, end });
        },
    };
}
