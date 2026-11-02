import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import type { FunctionModel } from "./models";
import { assignmentKey, assignmentOperators, diagnostic, isIncrementOrDecrement, type Context, type State } from "./execution-state";

export function countWrites(node: TS.Node, name: string): number {
    let count = 0;
    const visit = (child: TS.Node): void => {
        const target = ts.isBinaryExpression(child) && assignmentOperators().has(child.operatorToken.kind) ? child.left
            : isIncrementOrDecrement(child) ? child.operand : undefined;
        if (target && assignmentKey(target)?.split(".")[0] === name) count++;
        ts.forEachChild(child, visit);
    };
    visit(node);
    return count;
}

export function countTopLevelWrites(sourceFile: TS.SourceFile, name: string): number {
    return sourceFile.statements.reduce((total, statement) => total + (ts.isExpressionStatement(statement) ? countWrites(statement, name) : 0), 0);
}

/** Local names bound to the logic library module: namespace imports and individually imported builders. */
export function logicLibraryBindings(sourceFile: TS.SourceFile): { readonly namespaces: Set<string>; readonly builders: Set<string>; } {
    const namespaces = new Set<string>();
    const builders = new Set<string>();
    for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)
            || !/\/smt$/.test(nameText(statement.moduleSpecifier))) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(nameText(bindings.name));
        else if (bindings) for (const element of bindings.elements) builders.add(nameText(element.name));
    }
    return { namespaces, builders };
}

export function isInsideSpecification(node: TS.Node, library: ReturnType<typeof logicLibraryBindings>): boolean {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isLabeledStatement(current) && (nameText(current.label) === "assert" || nameText(current.label) === "assume")) return true;
        // Arguments of logic library builders belong to logic definitions and axioms.
        if (ts.isCallExpression(current) && (
            ts.isPropertyAccessExpression(current.expression) && ts.isIdentifier(current.expression.expression)
                && library.namespaces.has(nameText(current.expression.expression))
            || ts.isIdentifier(current.expression) && library.builders.has(nameText(current.expression)))) return true;
        if (ts.isFunctionLike(current) && !ts.isArrowFunction(current) && !ts.isFunctionExpression(current)) return false;
    }
    return false;
}

/** Reports assertions, guarded calls, and contract returns the executor never reached, rather than letting them pass. */
export function reportUnvisited(sourceFile: TS.SourceFile, context: Context, rejected: ReadonlySet<TS.Node>): void {
    const library = logicLibraryBindings(sourceFile);
    const reject = (node: TS.Node, what: string) => {
        if (!context.visited.has(node)) diagnostic(context, node, `${what} is outside the code the verifier can analyze, so it is not verified.`);
    };
    const visit = (node: TS.Node, owner: FunctionModel | undefined): void => {
        if (rejected.has(node)) return;
        if (ts.isLabeledStatement(node) && (nameText(node.label) === "assert" || nameText(node.label) === "assume")) reject(node, `This ${nameText(node.label)}`);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const model = context.functions.get(nameText(node.expression));
            if (model && (model.requires.length || Object.keys(model.parameterRefinements ?? {}).length)) reject(node, `The call to '${model.name}'`);
        }
        if (ts.isReturnStatement(node) && owner && (owner.ensures.length || owner.returnRefinement)) reject(node, "This return");
        // Logic functions throw when called at runtime, so they may only appear in erased proof syntax.
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && context.logic.functions[nameText(node.expression)]
            && !context.functions.has(nameText(node.expression))
            && !isInsideSpecification(node, library)) {
            diagnostic(context, node, `Logic function '${nameText(node.expression)}' can only be used in a formal verification specification.`);
        }
        const nextOwner = !ts.isFunctionLike(node) ? owner
            : ts.isFunctionDeclaration(node) && node.parent === sourceFile && node.name ? context.functions.get(nameText(node.name)) : undefined;
        ts.forEachChild(node, child => visit(child, nextOwner));
    };
    visit(sourceFile, undefined);
}

/** Whether an expression contains an operation that creates a proof obligation: division, a call to a function with a
 *  precondition, or arithmetic on a value the proof tracks. */
export function mayCarryObligations(node: TS.Node, state: State, context: Context): boolean {
    const tracked = (operand: TS.Expression) => {
        const name = ts.isIdentifier(operand) ? nameText(operand)
            : ts.isPropertyAccessExpression(operand) && ts.isIdentifier(operand.expression) ? `${nameText(operand.expression)}.${nameText(operand.name)}` : undefined;
        return name !== undefined && (name in state.variables || name in state.values) || ts.isNumericLiteral(operand) || ts.isBigIntLiteral(operand);
    };
    const visit = (current: TS.Node): boolean => {
        if (ts.isBinaryExpression(current)) {
            const operator = current.operatorToken.kind;
            if (operator === ts.SyntaxKind.SlashToken || operator === ts.SyntaxKind.PercentToken) return true;
            if ((operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.AsteriskToken)
                && (tracked(current.left) || tracked(current.right))) return true;
        }
        if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
            const model = context.functions.get(nameText(current.expression));
            if (model && (model.requires.length || Object.keys(model.parameterRefinements ?? {}).length)) return true;
        }
        return !!ts.forEachChild(current, child => visit(child) || undefined);
    };
    return visit(node);
}
