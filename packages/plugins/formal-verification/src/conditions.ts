import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import { strictlyLessThan, strictEquality, stringLengthTerm, type Term } from "./expression";
import { cloneState, isIncrementOrDecrement, type Context, type State } from "./execution-state";
import { mayWriteValues } from "./coverage";

interface ConditionExecutor {
    lowerExpression(node: TS.Expression, state: State, context: Context): Term;
    updateIncrement(node: TS.PrefixUnaryExpression | TS.PostfixUnaryExpression, state: State, context: Context): Term | undefined;
}

export function isStrictEquality(operator: TS.SyntaxKind): boolean {
    return operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken;
}

export function lowerEquality(
    node: TS.BinaryExpression, state: State, context: Context,
    lowerOperand: (node: TS.Expression, state: State, context: Context) => Term,
): Term {
    const operand = (expression: TS.Expression): { term: Term; inBounds?: string; } => {
        while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
        if (ts.isElementAccessExpression(expression) && !expression.questionDotToken && ts.isIdentifier(expression.expression)) {
            const name = nameText(expression.expression);
            if ((state.values[name]?.sort ?? state.variables[name]) === "String") {
                const receiver = lowerOperand(expression.expression, state, context);
                const index = lowerOperand(expression.argumentExpression, state, context);
                if (index.sort !== "Int" && index.sort !== "NumberInt") throw new Error("A string element comparison requires an integer index.");
                const length = stringLengthTerm(receiver);
                // An out-of-range access is undefined in JavaScript. str.at alone would compare it as "".
                return {
                    term: { smt: `(str.at ${receiver.smt} ${index.smt})`, sort: "String" },
                    inBounds: `(and (<= 0 ${index.smt}) ${strictlyLessThan(index, length)})`,
                };
            }
        }
        return { term: lowerOperand(expression, state, context) };
    };
    const left = operand(node.left);
    const right = operand(node.right);
    if (left.inBounds && right.inBounds) throw new Error("Compare a string element to a string value.");
    const bounds = left.inBounds ?? right.inBounds;
    const equal = strictEquality(left.term, right.term);
    const match = bounds ? `(and ${bounds} ${equal})` : equal;
    return { smt: node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? match : `(not ${match})`, sort: "Bool" };
}

/** Split before evaluating a side-effecting right operand, retaining the writes on both resulting paths. */
export function conditionPaths(
    node: TS.Expression, state: State, context: Context, executor: ConditionExecutor,
): { truthy: State[]; falsy: State[]; } {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (ts.isBinaryExpression(node) && mayWriteValues(node)) {
        const operator = node.operatorToken.kind;
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken || operator === ts.SyntaxKind.BarBarToken) {
            const left = conditionPaths(node.left, state, context, executor);
            const and = operator === ts.SyntaxKind.AmpersandAmpersandToken;
            const right = (and ? left.truthy : left.falsy).map(next => conditionPaths(node.right, next, context, executor));
            return {
                truthy: [...(and ? [] : left.truthy), ...right.flatMap(next => next.truthy)],
                falsy: [...(and ? left.falsy : []), ...right.flatMap(next => next.falsy)],
            };
        }
    }
    const lowerOperand = (operand: TS.Expression, current: State, scope: Context): Term => {
        if (!isIncrementOrDecrement(operand)) return executor.lowerExpression(operand, current, scope);
        if (ts.isIdentifier(operand.operand)) {
            const value = executor.updateIncrement(operand, current, scope);
            if (value) return value;
        }
        throw new Error("Only local variables can be incremented in a condition.");
    };
    const condition = ts.isBinaryExpression(node) && isStrictEquality(node.operatorToken.kind)
        ? lowerEquality(node, state, context, lowerOperand)
        : executor.lowerExpression(node, state, context);
    if (condition.sort !== "Bool") throw new Error("An if condition must be Boolean.");
    const whenTrue = cloneState(state); whenTrue.facts.push(condition.smt);
    const whenFalse = cloneState(state); whenFalse.facts.push(`(not ${condition.smt})`);
    return { truthy: [whenTrue], falsy: [whenFalse] };
}
