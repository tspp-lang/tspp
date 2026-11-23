import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { resolveMappedIndex } from "./mapped-super-checks";
import type { MultipleBases, MultipleInheritance } from "./multiple-inheritance";

/** The checker sees an instance/static type assertion; only emit accesses the selected base's prototype. */
export function createQualifiedSuperEmit(ts: TSPPTypeScript, multiple: MultipleInheritance, context: TS.TransformationContext, checker: TS.TypeChecker) {
    const f = context.factory;
    return {
        rewrite(declaration: TS.ClassDeclaration, info: MultipleBases, capture: TS.Identifier): TS.ClassDeclaration {
            const unwrap = (node: TS.Node): TS.Node => ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node) ? unwrap(node.expression) : node;
            const reflect = (name: string) => f.createPropertyAccessExpression(f.createPropertyAccessExpression(f.createIdentifier("globalThis"), "Reflect"), name);
            const selected = (node: TS.Node) => (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && multiple.getSelectedSuper(node.expression);
            const read = (node: TS.PropertyAccessExpression | TS.ElementAccessExpression): TS.Expression => {
                const selection = multiple.getSelectedSuper(node.expression)!;
                const index = resolveMappedIndex(ts, multiple, info, { ...selection, label: false }, checker);
                const base = f.createElementAccessExpression(capture, Math.max(index, 0));
                const target = selection.isStatic ? base : f.createPropertyAccessExpression(base, "prototype");
                const key = ts.isPropertyAccessExpression(node) ? f.createStringLiteral(ts.idText(node.name)) : ts.visitNode(node.argumentExpression, visit) as TS.Expression;
                return f.createCallExpression(reflect("get"), undefined, [target, key, f.createThis()]);
            };
            const visit = (node: TS.Node): TS.Node => {
                if (node !== declaration && ts.isClassLike(node)) return node;
                if (ts.isCallExpression(node) && selected(unwrap(node.expression))) {
                    return f.createCallExpression(reflect("apply"), undefined, [
                        read(unwrap(node.expression) as TS.PropertyAccessExpression | TS.ElementAccessExpression), f.createThis(),
                        f.createArrayLiteralExpression(node.arguments.map(argument => ts.visitNode(argument, visit) as TS.Expression)),
                    ]);
                }
                if (selected(node)) return read(node as TS.PropertyAccessExpression | TS.ElementAccessExpression);
                return ts.visitEachChild(node, visit, context);
            };
            return ts.visitEachChild(declaration, visit, context);
        },
    };
}
