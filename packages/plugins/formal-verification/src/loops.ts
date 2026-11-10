import type * as TS from "typescript-upstream";
import { nameText, nodeStart, ts } from "./host-api";
import { matchingBrace, parseProperties } from "./contracts";
import { expressionToSmtTerm, type Term } from "./expression";
import type { Clause } from "./models";
import {
    addProof, assignedKeys, assignmentKey, assignmentOperators, cloneState, havoc, isBound,
    isIncrementOrDecrement, unsupported, type Context, type JumpTarget, type State,
} from "./execution-state";

interface LoopExecutor {
    lowerExpression(node: TS.Expression, state: State, context: Context): Term;
    executeStatement(node: TS.Statement, state: State, context: Context): State[];
    updateIncrement(node: TS.PrefixUnaryExpression | TS.PostfixUnaryExpression, state: State, context: Context): Term | undefined;
}

interface Invariant {
    readonly term: (state: State) => string;
    readonly location?: Clause;
}

export function loopInvariants(node: TS.WhileStatement, context: Context): Clause[] {
    const between = context.sourceText.slice(node.expression.end, nodeStart(node.statement, context.sourceFile));
    const withOffset = between.indexOf("with");
    if (withOffset < 0) return [];
    const open = context.sourceText.indexOf("{", node.expression.end + withOffset);
    const close = matchingBrace(context.sourceText, open);
    return parseProperties(context.sourceText.slice(open + 1, close), open + 1).filter(item => item.name === "invariant");
}

/** Check initiation and preservation, then use the invariant on an arbitrary iteration or at the exit. */
function executeLoop(
    node: TS.ForStatement | TS.WhileStatement, condition: TS.Expression, state: State, context: Context,
    executor: LoopExecutor, invariants: readonly Invariant[], step?: TS.PrefixUnaryExpression | TS.PostfixUnaryExpression,
): State[] {
    for (const invariant of invariants) {
        addProof(context, state, invariant.term(state), node, "loop invariant initialization", invariant.location);
    }
    const iteration = cloneState(state);
    for (const key of assignedKeys(node)) havoc(iteration, key, context);
    for (const invariant of invariants) iteration.facts.push(invariant.term(iteration));
    const test = executor.lowerExpression(condition, iteration, context);
    if (test.sort !== "Bool") throw new Error("A loop condition must be Boolean.");

    const body = cloneState(iteration);
    body.facts.push(test.smt);
    const target: JumpTarget = { kind: "loop", breaks: [], continues: [] };
    let afterBody: State[];
    context.jumpTargets.push(target);
    try { afterBody = executor.executeStatement(node.statement, body, context); }
    finally { context.jumpTargets.pop(); }
    const backEdges = [...afterBody, ...target.continues];
    for (const next of backEdges) {
        if (step && !executor.updateIncrement(step, next, context)) unsupported(next, step, context);
        for (const invariant of invariants) {
            addProof(context, next, invariant.term(next), node, "loop invariant preservation", invariant.location);
        }
    }

    iteration.facts.push(`(not ${test.smt})`);
    // The havoc only covers syntactic assignments, so a body we could not model can invalidate the exit proof.
    iteration.unsupported ??= [...backEdges, ...target.breaks].find(next => next.unsupported)?.unsupported;
    return [iteration, ...target.breaks];
}

export function executeWhile(node: TS.WhileStatement, state: State, context: Context, executor: LoopExecutor): State[] {
    const invariants = loopInvariants(node, context).map(location => ({
        location,
        term: (current: State) => expressionToSmtTerm(location.value, {
            variables: current.variables, substitutions: current.values, functions: context.logic.functions,
            defaultNumberSort: context.currentFunction?.numberModel === "mathematical-real" ? "Real" : "NumberInt",
        }).smt,
    }));
    return executeLoop(node, node.expression, state, context, executor, invariants);
}

function hasUntrackedLoopWrites(node: TS.Node): boolean {
    // A var initializer writes a function-scoped binding. Calls and closures may hide other writes.
    return (ts.isVariableDeclarationList(node) && !(node.flags & ts.NodeFlags.BlockScoped))
        || ts.isFunctionLike(node) || ts.isCallExpression(node) || ts.isNewExpression(node)
        || !!ts.forEachChild(node, child => hasUntrackedLoopWrites(child) || undefined);
}

function readsAtIndex(node: TS.Expression, index: string, state: State): boolean {
    return ts.isElementAccessExpression(node) && !node.questionDotToken && ts.isIdentifier(node.expression)
        && assignmentKey(node.argumentExpression) === index
        && (state.values[nameText(node.expression)]?.sort ?? state.variables[nameText(node.expression)]) === "String";
}

function checksIndex(node: TS.Expression, index: string, state: State): boolean {
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
        && (readsAtIndex(node.left, index, state) || readsAtIndex(node.right, index, state));
}

/**
 * A counter starting at zero, changed by at most one in each direction per iteration and only when a
 * string element matches, is bounded in magnitude by max(index, 0). String matches imply a nonnegative index.
 * These syntactic rules only select candidates. The solver still checks both obligations for each bound.
 */
function stringScanInvariants(body: TS.Statement, index: string, state: State): Invariant[] {
    const candidates = new Map([...assignedKeys(body)].filter(key =>
        (state.values[key]?.sort === "Int" || state.values[key]?.sort === "NumberInt")
        && state.values[key].smt === "0").map(key => [key, new Set<number>()]));
    const visit = (node: TS.Node, guarded: boolean): void => {
        if (!candidates.size || ts.isFunctionLike(node)) return;
        if (ts.isIfStatement(node)) {
            visit(node.expression, guarded);
            visit(node.thenStatement, guarded || checksIndex(node.expression, index, state));
            if (node.elseStatement) visit(node.elseStatement, guarded);
            return;
        }
        if (ts.isBinaryExpression(node)) {
            if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                visit(node.left, guarded);
                visit(node.right, guarded || checksIndex(node.left, index, state));
                return;
            }
            if (assignmentOperators().has(node.operatorToken.kind)) candidates.delete(assignmentKey(node.left) ?? "");
        }
        if (isIncrementOrDecrement(node)) {
            const key = assignmentKey(node.operand) ?? "";
            const directions = candidates.get(key);
            if (directions) {
                if (!guarded || directions.has(node.operator)) candidates.delete(key);
                else directions.add(node.operator);
            }
        }
        ts.forEachChild(node, child => visit(child, guarded));
    };
    visit(body, false);
    return [...candidates].map(([key]) => ({
        term: (current: State) => {
            const counter = current.values[index].smt;
            const value = current.values[key].smt;
            const bound = `(ite (>= ${counter} 0) ${counter} 0)`;
            return `(and (>= ${value} (- ${bound})) (<= ${value} ${bound}))`;
        },
    }));
}

export function executeFor(node: TS.ForStatement, state: State, context: Context, executor: LoopExecutor): State[] {
    const { initializer, condition, incrementor } = node;
    if (!initializer || !ts.isVariableDeclarationList(initializer) || !(initializer.flags & ts.NodeFlags.Let)
        || initializer.declarations.length !== 1 || !condition || !ts.isBinaryExpression(condition)
        || condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken
        || !incrementor || !isIncrementOrDecrement(incrementor) || incrementor.operator !== ts.SyntaxKind.PlusPlusToken) {
        return unsupported(state, node, context);
    }
    const [declaration] = initializer.declarations;
    if (!declaration.initializer || !ts.isIdentifier(declaration.name) || declaration.type) return unsupported(state, node, context);
    const index = nameText(declaration.name);
    if (isBound(state, index) || assignmentKey(condition.left) !== index || assignmentKey(incrementor.operand) !== index
        || assignedKeys(node.statement).has(index) || assignedKeys(condition).size
        || hasUntrackedLoopWrites(node)) {
        return unsupported(state, node, context);
    }
    const entry = cloneState(state);
    const start = executor.lowerExpression(declaration.initializer, entry, context);
    if (start.sort !== "Int" && start.sort !== "NumberInt") return unsupported(state, node, context);
    entry.values[index] = start;
    const invariants: Invariant[] = [
        { term: current => `(>= ${current.values[index].smt} ${start.smt})` },
        ...stringScanInvariants(node.statement, index, entry),
    ];
    const exits = executeLoop(node, condition, entry, context, executor, invariants, incrementor);
    for (const exit of exits) delete exit.values[index];
    return exits;
}
