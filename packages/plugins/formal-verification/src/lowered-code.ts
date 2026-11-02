import type * as TS from "typescript-upstream";
import { mayCarryObligations } from "./coverage";
import { assignmentKey, cloneState, isBound, lexicalNames, type Context, type State } from "./execution-state";
import type { Sort, Term } from "./expression";
import { nameText, ts } from "./host-api";
import type { DataConstructor } from "./models";

// What syntax plugins lower to, as far as proofs can follow: functions invoked in place, conditional expressions, and
// data fields read by position under a test of their variant. All of it is ordinary TypeScript.

/** The executor's entry points, which the code here calls back into. */
export interface Lowering {
    lowerExpression(node: TS.Expression, state: State, context: Context): Term;
    executeStatements(nodes: readonly TS.Statement[], states: State[], context: Context): State[];
}

/** The function an immediately invoked call runs, as in `(() => { ... })()` and `((x) => x + 1n)(y)`. */
export function immediatelyInvoked(node: TS.CallExpression): TS.ArrowFunction | TS.FunctionExpression | undefined {
    let callee: TS.Expression = node.expression;
    while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
    return ts.isArrowFunction(callee) || ts.isFunctionExpression(callee) ? callee : undefined;
}

/**
 * Runs an immediately invoked function in place, with its parameters bound to its arguments. The function's own
 * bindings are gone afterwards, and only a single-valued result leaves it: paths that return different values are
 * joined by the conditions that lead to them.
 */
export function lowerImmediateCall(
    node: TS.CallExpression, callee: TS.ArrowFunction | TS.FunctionExpression, state: State, context: Context, { lowerExpression, executeStatements }: Lowering,
): Term {
    if (callee.asteriskToken || callee.modifiers?.length) throw new Error("Only plain immediately invoked functions can participate in formal verification.");
    const saved: [string, Term | undefined, Sort | undefined][] = [];
    callee.parameters.forEach((parameter, index) => {
        if (!ts.isIdentifier(parameter.name)) throw new Error("Only named parameters of immediately invoked functions can participate in formal verification.");
        const argument = node.arguments[index] ?? parameter.initializer;
        const name = nameText(parameter.name);
        saved.push([name, state.values[name], state.variables[name]]);
        delete state.values[name];
        delete state.variables[name];
        // A value outside the model is fine until something reads the name, which then reports it as unknown.
        try {
            if (argument) {
                const value = lowerExpression(argument, state, context);
                state.values[name] = value;
                state.variables[name] = value.sort;
            }
        }
        catch (error) { if (argument && mayCarryObligations(argument, state, context)) throw error; }
    });
    const restore = (target: State) => {
        for (const [name, value, sort] of saved) {
            if (value) target.values[name] = value; else delete target.values[name];
            if (sort) target.variables[name] = sort; else delete target.variables[name];
        }
    };
    let result: Term;
    if (!ts.isBlock(callee.body)) result = lowerExpression(callee.body, state, context);
    else {
        const scoped = lexicalNames(callee.body.statements).filter(name => !isBound(state, name));
        const before = new Set(state.facts);
        const returns: NonNullable<Context["inlineReturns"]>[number][] = [];
        const finished = executeStatements(callee.body.statements, [cloneState(state)], { ...context, inlineReturns: returns });
        if (finished.length) throw new Error("An immediately invoked function that can finish without returning cannot participate in formal verification.");
        if (!returns.length || returns.some(item => !item.value)) throw new Error("An immediately invoked function must return a value to participate in formal verification.");
        const conditionOf = (item: typeof returns[number]) => {
            const added = item.state.facts.filter(fact => !before.has(fact));
            return added.length ? `(and ${added.join(" ")} true)` : "true";
        };
        result = returns[returns.length - 1].value!;
        for (const item of returns.slice(0, -1).reverse()) {
            if (item.value!.sort !== result.sort) throw new Error("The paths of an immediately invoked function return different proof sorts.");
            result = { smt: `(ite ${conditionOf(item)} ${item.value!.smt} ${result.smt})`, sort: result.sort };
        }
        for (const item of returns) {
            for (const declaration of item.state.declarations) state.declarations.add(declaration);
            if (item.state.unsupported) state.unsupported ??= item.state.unsupported;
            // A path that wrote an outer value would need joining too.
            for (const key of new Set([...Object.keys(state.values), ...Object.keys(item.state.values)])) {
                if (!scoped.includes(key) && item.state.values[key]?.smt !== state.values[key]?.smt) throw new Error("An immediately invoked function that assigns an outer value cannot participate in formal verification.");
            }
        }
    }
    restore(state);
    return result;
}

/** The reference and variant of a test such as `value._tag === "Some"`, when `value` holds a modeled data type. */
function variantTest(node: TS.Expression, context: Context): { readonly reference: string; readonly constructor: DataConstructor; } | undefined {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return undefined;
    if (!ts.isPropertyAccessExpression(node.left) || !ts.isStringLiteralLike(node.right)) return undefined;
    const tag = nameText(node.right);
    const reference = assignmentKey(node.left.expression);
    const property = nameText(node.left.name);
    const constructor = [...context.constructors.values()].find(candidate => candidate.tagProperty === property && candidate.tag === tag);
    return reference && constructor ? { reference, constructor } : undefined;
}

/** `value._values[0]` under a test of `value`'s variant reads that variant's field, by the name proofs know it by. */
export function lowerPositionalField(node: TS.ElementAccessExpression, state: State): Term | undefined {
    if (!ts.isNumericLiteral(node.argumentExpression) || !ts.isPropertyAccessExpression(node.expression)) return undefined;
    const reference = assignmentKey(node.expression.expression);
    const constructor = reference ? state.variants?.[reference] : undefined;
    if (!reference || !constructor || nameText(node.expression.name) !== constructor.valuesProperty) return undefined;
    const field = constructor.fields[Number(nameText(node.argumentExpression))];
    const key = field && `${reference}.${field}`;
    return key ? state.values[key] ?? (state.variables[key] ? { smt: `|${key}|`, sort: state.variables[key] } : undefined) : undefined;
}

/** Both branches under their condition, so obligations in a branch only hold on its own path. */
export function lowerConditional(node: TS.ConditionalExpression, state: State, context: Context, { lowerExpression }: Lowering): Term {
    const condition = lowerExpression(node.condition, state, context);
    if (condition.sort !== "Bool") throw new Error("A condition must be Boolean.");
    const test = variantTest(node.condition, context);
    const whenTrue = cloneState(state);
    whenTrue.facts.push(condition.smt);
    if (test) (whenTrue as { variants?: State["variants"]; }).variants = { ...state.variants, [test.reference]: test.constructor };
    const whenFalse = cloneState(state);
    whenFalse.facts.push(`(not ${condition.smt})`);
    const trueValue = lowerExpression(node.whenTrue, whenTrue, context);
    // `... as never` marks a branch the program claims is unreachable, such as the end of an exhaustive match.
    if (isNeverAssertion(node.whenFalse)) {
        for (const declaration of whenTrue.declarations) state.declarations.add(declaration);
        return trueValue;
    }
    const falseValue = lowerExpression(node.whenFalse, whenFalse, context);
    if (trueValue.sort !== falseValue.sort) throw new Error("Both branches of a condition must have the same proof sort.");
    for (const declaration of [...whenTrue.declarations, ...whenFalse.declarations]) state.declarations.add(declaration);
    return { smt: `(ite ${condition.smt} ${trueValue.smt} ${falseValue.smt})`, sort: trueValue.sort };
}

function isNeverAssertion(node: TS.Expression): boolean {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    return ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.NeverKeyword;
}

/** What a return of a data value or record proves about `result`, field by field. */
export function lowerStructuredResult(node: TS.Expression, state: State, context: Context, lowering: Lowering): Record<string, Term> | undefined {
    const { lowerExpression } = lowering;
    if (ts.isParenthesizedExpression(node)) return lowerStructuredResult(node.expression, state, context, lowering);
    if (ts.isIdentifier(node)) {
        const constructor = context.constructors.get(nameText(node));
        if (constructor) return { [`result.${constructor.tagProperty}`]: { smt: `"${constructor.tag}"`, sort: "String" } };
        // Returning a record parameter returns each of its fields.
        const prefix = `${nameText(node)}.`;
        const fields = Object.keys({ ...state.variables, ...state.values }).filter(key => key.startsWith(prefix));
        if (!fields.length) return undefined;
        return Object.fromEntries(fields.map(key => [`result.${key.slice(prefix.length)}`, lowerFieldKey(key, state)]));
    }
    if (ts.isObjectLiteralExpression(node)) {
        const result: Record<string, Term> = {};
        for (const property of node.properties) {
            if (ts.isShorthandPropertyAssignment(property)) result[`result.${nameText(property.name)}`] = lowerExpression(property.name, state, context);
            else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
                result[`result.${nameText(property.name)}`] = lowerExpression(property.initializer, state, context);
            }
            else return undefined;
        }
        return result;
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return undefined;
    const constructor = context.constructors.get(nameText(node.expression));
    if (!constructor || constructor.fields.length !== node.arguments.length) return undefined;
    const result: Record<string, Term> = { [`result.${constructor.tagProperty}`]: { smt: `"${constructor.tag}"`, sort: "String" } };
    constructor.fields.forEach((field, index) => {
        try { result[`result.${field}`] = lowerExpression(node.arguments[index], state, context); }
        catch { /* Recursive fields need no scalar SMT binding until selected. */ }
    });
    return result;
}

function lowerFieldKey(key: string, state: State): Term {
    return state.values[key] ?? { smt: `|${key}|`, sort: state.variables[key] };
}
