import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import { guardsCalls } from "./models";
import { guardedMethodNames, memberName, resolveCallTarget } from "./classes";
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
    const guardedNames = guardedMethodNames(context.classes);
    // The members whose returns owe a proof: a contract on their result, or an invariant of their class.
    const owingReturns = new Set<TS.Node>();
    for (const owner of context.classes.values()) {
        for (const member of owner.members) {
            if (member.declaration && (member.model.ensures.length || member.model.returnRefinement || owner.invariants.length && !member.isStatic)) {
                owingReturns.add(member.declaration);
            }
        }
    }
    const visit = (node: TS.Node, owesReturn: boolean): void => {
        if (rejected.has(node)) return;
        if (ts.isLabeledStatement(node) && (nameText(node.label) === "assert" || nameText(node.label) === "assume")) reject(node, `This ${nameText(node.label)}`);
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
            const model = context.functions.get(nameText(node.expression));
            if (model && guardsCalls(model)) reject(node, `The call to '${model.name}'`);
        }
        else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !context.visited.has(node)) {
            const target = resolveCallTarget(node, context.classes);
            const name = ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) ? memberName(node.expression.name) : undefined;
            if (target && guardsCalls(target.member.model)) reject(node, `The call to '${target.member.model.name}'`);
            else if (!target && name !== undefined && guardedNames.has(name)) {
                diagnostic(context, node, `The class of the receiver of '${name}' cannot be determined, so a precondition of '${name}' may go unchecked; declare the receiver with the type of a class in this file.`);
            }
        }
        if (ts.isReturnStatement(node) && owesReturn) reject(node, "This return");
        // Logic functions throw when called at runtime, so they may only appear in erased proof syntax.
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && context.logic.functions[nameText(node.expression)]
            && !context.functions.has(nameText(node.expression))
            && !isInsideSpecification(node, library)) {
            diagnostic(context, node, `Logic function '${nameText(node.expression)}' can only be used in a formal verification specification.`);
        }
        let next = owesReturn;
        if (ts.isFunctionLike(node)) {
            const model = ts.isFunctionDeclaration(node) && node.parent === sourceFile && node.name ? context.functions.get(nameText(node.name)) : undefined;
            next = !!model && (model.ensures.length > 0 || !!model.returnRefinement) || owingReturns.has(node);
        }
        ts.forEachChild(node, child => visit(child, next));
    };
    visit(sourceFile, false);
}

/** Whether evaluating an expression may write a value proofs read: an assignment in it, or a function it could run. */
export function mayWriteValues(node: TS.Node): boolean {
    const visit = (current: TS.Node): boolean => {
        if (ts.isBinaryExpression(current) && assignmentOperators().has(current.operatorToken.kind)) return true;
        if (isIncrementOrDecrement(current)) return true;
        // A function invoked in place runs what it contains; any other could run anything later.
        if (ts.isCallExpression(current)) {
            let callee: TS.Expression = current.expression;
            while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
            if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
                return !!ts.forEachChild(callee, child => visit(child) || undefined) || current.arguments.some(visit);
            }
        }
        if (ts.isFunctionLike(current)) return true;
        return !!ts.forEachChild(current, child => visit(child) || undefined);
    };
    return visit(node);
}

/** Whether an expression contains an operation that creates a proof obligation: division, a call to a function with a
 *  precondition, or, under the safe-integer model, arithmetic on a value the proof tracks. */
export function mayCarryObligations(node: TS.Node, state: State, context: Context): boolean {
    const safeInteger = context.currentFunction?.numberModel === "safe-integer";
    const tracked = (operand: TS.Expression) => {
        const name = ts.isIdentifier(operand) ? nameText(operand)
            : ts.isPropertyAccessExpression(operand) && ts.isIdentifier(operand.expression) ? `${nameText(operand.expression)}.${nameText(operand.name)}` : undefined;
        return name !== undefined && (name in state.variables || name in state.values) || ts.isNumericLiteral(operand) || ts.isBigIntLiteral(operand);
    };
    const visit = (current: TS.Node): boolean => {
        if (ts.isBinaryExpression(current)) {
            const operator = current.operatorToken.kind;
            if (operator === ts.SyntaxKind.SlashToken || operator === ts.SyntaxKind.PercentToken) return true;
            if (safeInteger && (operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.AsteriskToken)
                && (tracked(current.left) || tracked(current.right))) return true;
        }
        if (ts.isCallExpression(current) && ts.isIdentifier(current.expression)) {
            const model = context.functions.get(nameText(current.expression));
            if (model && guardsCalls(model)) return true;
        }
        else if (ts.isCallExpression(current) || ts.isNewExpression(current)) {
            const target = resolveCallTarget(current, context.classes);
            if (target && guardsCalls(target.member.model)) return true;
        }
        return !!ts.forEachChild(current, child => visit(child) || undefined);
    };
    return visit(node);
}
