import type * as TS from "typescript-upstream";
import { nameText, nodeStart, ts } from "./host-api";
import { expressionToSmtTerm, type Sort, type Term } from "./expression";
import { lowerCallArguments, type Lowering } from "./lowered-code";
import type { LogicLibrary } from "./logic";
import { participatesInVerification, type Clause, type FunctionModel } from "./models";
import { addProof, diagnostic, havoc, initialState, isBound, type Context, type State } from "./execution-state";
import { mayCarryObligations } from "./coverage";
import { resolveCallTarget, type ClassModel, type MemberModel, type MethodTarget } from "./classes";

// Class members run on the same symbolic executor as functions. What is particular to them: the fields of `this`, the
// class invariant at every entry and exit, and calls that may come back into the object.

/** The executor's entry points; its statements call into members here, and members run statements there. */
export interface ExecutorHooks extends Lowering {
    owesProof(declaration: TS.FunctionLikeDeclaration, context: Context): boolean;
}

let hooks: ExecutorHooks;

export function connectExecutor(executor: ExecutorHooks): void {
    hooks = executor;
}

/** A contract clause with the arguments of a call, and the result and receiver fields when it reads them. */
export function instantiate(
    clause: string, names: readonly string[], values: readonly Term[], logic: LogicLibrary,
    result?: Term, numberModel?: FunctionModel["numberModel"], fields: Readonly<Record<string, Term>> = {},
): Term {
    const substitutions: Record<string, Term> = { ...fields };
    names.forEach((name, index) => substitutions[name] = values[index]);
    if (result) substitutions.result = result;
    return expressionToSmtTerm(clause, {
        substitutions, functions: logic.functions,
        defaultNumberSort: numberModel === "mathematical-real" ? "Real" : "Int",
    });
}

/** `Math.max`, `Math.min`, and `Math.abs` over one numeric sort. NaN is outside every number model, as elsewhere. */
export function lowerMathCall(node: TS.CallExpression, state: State, context: Context): Term | undefined {
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression) || nameText(callee.expression) !== "Math" || isBound(state, "Math")) return undefined;
    const name = ts.idText(callee.name);
    if (name !== "max" && name !== "min" && name !== "abs") return undefined;
    context.visited.add(node);
    const arguments_ = node.arguments.map(argument => hooks.lowerExpression(argument, state, context));
    const sort = arguments_[0]?.sort;
    if (!sort || (name === "abs" && arguments_.length !== 1)) throw new Error(`Math.${name} needs ${name === "abs" ? "one argument" : "arguments"} to be modeled.`);
    if ((sort !== "Int" && sort !== "Real") || arguments_.some(argument => argument.sort !== sort)) throw new Error(`The arguments of Math.${name} must have the same numeric sort.`);
    if (name === "abs") {
        const [value] = arguments_;
        return { smt: `(ite (>= ${value.smt} ${sort === "Real" ? "0.0" : "0"}) ${value.smt} (- ${value.smt}))`, sort };
    }
    const keeps = name === "max" ? ">=" : "<=";
    return arguments_.reduce((left, right) => ({ smt: `(ite (${keeps} ${left.smt} ${right.smt}) ${left.smt} ${right.smt})`, sort }));
}

/** The current object's fields, under the names clauses read them by: `this.name`, and in invariants also `name`. */
function fieldTerms(owner: ClassModel, state: State, bare: boolean): Record<string, Term> {
    const terms: Record<string, Term> = {};
    for (const field of owner.fields.values()) {
        const sort = state.variables[field.key];
        const term = state.values[field.key] ?? (sort ? { smt: `|${field.key}|`, sort } : undefined);
        if (!term) continue;
        terms[field.key] = term;
        if (bare) terms[field.name] = term;
    }
    return terms;
}

function invariantTerm(owner: ClassModel, invariant: Clause, state: State, context: Context): Term {
    let term: Term;
    try {
        term = expressionToSmtTerm(invariant.value, {
            substitutions: fieldTerms(owner, state, true), functions: context.logic.functions,
            defaultNumberSort: owner.numberModel === "mathematical-real" ? "Real" : "Int",
        });
    }
    catch (error) {
        const unknown = error instanceof Error ? /^Unknown proof variable '(?:this\.)?(.+)'\.$/u.exec(error.message)?.[1] : undefined;
        const field = unknown === undefined ? undefined : owner.fields.get(unknown);
        if (!field) throw error;
        throw new Error(field.sort
            ? `'${field.name}' may be unassigned here, so the invariant of '${owner.name}' cannot be checked.`
            : `Field '${field.name}' of '${owner.name}' has a type proofs cannot model; annotate it with bigint, boolean, string, or number with a numberModel on the class.`);
    }
    if (term.sort !== "Bool") throw new Error(`The invariant of '${owner.name}' must be Boolean.`);
    return term;
}

export function proveInvariants(owner: ClassModel, state: State, node: TS.Node, where: string, context: Context, location?: Clause): void {
    for (const invariant of owner.invariants) {
        try { addProof(context, state, invariantTerm(owner, invariant, state, context).smt, node, `${owner.name} invariant '${invariant.value}' ${where}`, location); }
        catch (error) { diagnostic(context, node, `${(error instanceof Error ? error.message : String(error)).replace(/\.$/, "")} ${where}.`); }
    }
}

/**
 * Code a member calls may call back into its object, so before the call the object's invariant must hold, and after
 * it the fields are unknown again apart from the invariant.
 */
export function leaveObject(state: State, node: TS.Node, callee: string, context: Context): void {
    const current = context.currentMember;
    if (!current || current.member.isStatic) return;
    proveInvariants(current.owner, state, node, `before calling ${callee}`, context);
    for (const key of new Set([...Object.keys(state.values), ...Object.keys(state.variables)])) {
        if (key.startsWith("this.")) havoc(state, key, context);
    }
    for (const invariant of current.owner.invariants) {
        try { state.facts.push(invariantTerm(current.owner, invariant, state, context).smt); }
        catch { /* Reported when it was to be proved before the call. */ }
    }
}

/**
 * A call to a modeled method or constructor: its preconditions are proved with the arguments, and its postconditions
 * assumed of the result. Returns undefined for constructors, whose result is an object.
 */
export function lowerMemberCall(node: TS.CallExpression | TS.NewExpression, target: MethodTarget, state: State, context: Context): Term | undefined {
    context.visited.add(node);
    const { owner, member, receiver } = target;
    const model = member.model;
    // Numeric literals in the arguments take the callee's number model when the caller has none.
    const argumentContext = context.currentFunction?.numberModel || !model.numberModel ? context : { ...context, currentFunction: model };
    const arguments_ = lowerCallArguments(node, model, state, argumentContext, hooks);
    if (argumentContext !== context) context.nextTemporary = argumentContext.nextTemporary;
    const ownFields = receiver === "this" && context.currentMember?.owner === owner;
    const before = ownFields ? fieldTerms(owner, state, false) : {};
    for (const requirement of model.requires) {
        const goal = instantiate(requirement.value, model.parameters, arguments_, context.logic, undefined, model.numberModel, before);
        if (goal.sort !== "Bool") throw new Error(`The precondition of '${model.name}' is not Boolean.`);
        addProof(context, state, goal.smt, node, `${model.name} call precondition`);
    }
    for (const [parameter, refinement] of Object.entries(model.parameterRefinements ?? {})) {
        const index = model.parameters.indexOf(parameter);
        if (index < 0) continue;
        const goal = expressionToSmtTerm(refinement.predicate, { substitutions: { value: arguments_[index] }, functions: context.logic.functions });
        addProof(context, state, goal.smt, node.arguments?.[model.parameterPositions?.[index] ?? index] ?? node, `${refinement.name} argument refinement`);
    }
    leaveObject(state, node, model.name, context);
    if (member.kind === "constructor") return undefined;
    const sort: Sort = model.returnSort ?? "Int";
    const name = `tspp.call.${model.name}.${context.nextTemporary++}`;
    const result = { smt: `|${name}|`, sort } as const;
    state.declarations.add(`(declare-const |${name}| ${sort})`);
    if (model !== context.currentFunction) {
        const after = ownFields ? fieldTerms(owner, state, false) : {};
        for (const ensure of model.ensures) {
            try {
                const fact = instantiate(ensure.value, model.parameters, arguments_, context.logic, result, model.numberModel, after);
                if (fact.sort === "Bool") state.facts.push(fact.smt);
            }
            catch { /* A postcondition about another object's fields says nothing the caller can name. */ }
        }
        if (model.returnRefinement) {
            const fact = expressionToSmtTerm(model.returnRefinement.predicate, { substitutions: { value: result }, functions: context.logic.functions });
            if (fact.sort === "Bool") state.facts.push(fact.smt);
        }
    }
    return result;
}

/** Runs a `new` of a modeled class written where an object is created; true when `node` is one. */
export function lowerObjectCreation(node: TS.Expression, state: State, context: Context): boolean {
    while (ts.isParenthesizedExpression(node)) node = node.expression;
    if (!ts.isNewExpression(node)) return false;
    const target = resolveCallTarget(node, context.classes);
    if (!target) return false;
    lowerMemberCall(node, target, state, context);
    return true;
}

/** Proves what a member owes when it returns normally: its postconditions, and its class invariant. */
export function proveMemberExit(state: State, node: TS.Node, context: Context, result: Term | undefined, location?: Clause): void {
    const { owner, member } = context.currentMember!;
    const model = member.model;
    for (const ensure of model.ensures) {
        if (!result && /(?:^|[^\p{ID_Continue}$.])result(?![\p{ID_Continue}$])/u.test(ensure.value)) {
            throw new Error(`'${model.name}' must return a value its postcondition can read.`);
        }
        const goal = expressionToSmtTerm(ensure.value, {
            variables: state.variables, substitutions: { ...state.values, ...(result ? { result } : {}) },
            functions: context.logic.functions, defaultNumberSort: model.numberModel === "mathematical-real" ? "Real" : "Int",
        });
        if (goal.sort !== "Bool") throw new Error("A postcondition must be Boolean.");
        addProof(context, state, goal.smt, node, `${model.name} postcondition`, ensure);
    }
    if (model.returnRefinement && result) {
        const goal = expressionToSmtTerm(model.returnRefinement.predicate, { substitutions: { value: result }, functions: context.logic.functions });
        addProof(context, state, goal.smt, node, `${model.returnRefinement.name} return refinement`);
    }
    if (!member.isStatic) {
        proveInvariants(owner, state, node, member.kind === "constructor" ? "after the constructor" : `on exit from ${member.name}`, context, location);
    }
}

/** Where a member's body starts its own state: the constructor builds the fields, a method assumes the invariant. */
function memberEntryState(owner: ClassModel, member: MemberModel, context: Context): State {
    const model = member.model;
    if (member.kind === "constructor") {
        const state = initialState(model, context.logic);
        // Parameter properties are assigned before field initializers, which run in source order before the body.
        for (const field of owner.fields.values()) {
            if (field.parameter === undefined || !field.sort || state.variables[field.parameter] !== field.sort) continue;
            state.values[field.key] = { smt: `|${field.parameter}|`, sort: field.sort };
        }
        for (const field of owner.fields.values()) {
            if (!field.initializer || lowerObjectCreation(field.initializer, state, context)) continue;
            try {
                const value = hooks.lowerExpression(field.initializer, state, context);
                if (field.sort && value.sort === field.sort) state.values[field.key] = value;
            }
            catch (error) {
                if (owner.invariantFields.has(field.name) || mayCarryObligations(field.initializer, state, context)) diagnostic(context, field.initializer, error);
                else if (field.sort) {
                    state.variables[field.key] = field.sort;
                    havoc(state, field.key, context);
                }
            }
        }
        return state;
    }
    const variables = { ...model.variables };
    if (!member.isStatic) for (const field of owner.fields.values()) if (field.sort) variables[field.key] = field.sort;
    const state = initialState({ ...model, variables }, context.logic);
    if (!member.isStatic) for (const invariant of owner.invariants) state.facts.push(invariantTerm(owner, invariant, state, context).smt);
    return state;
}

/**
 * Verifies one member when its class has an invariant, it has a contract of its own, or its body owes a proof. Returns
 * the next temporary number when it ran.
 */
export function verifyMember(owner: ClassModel, member: MemberModel, base: Omit<Context, "currentFunction">, rejected: Set<TS.Node>): number | undefined {
    const declaration = member.declaration;
    if (declaration && (!declaration.body || declaration.body.pos < 0)) return undefined;
    const context: Context = { ...base, currentFunction: member.model, currentMember: { owner, member } };
    const required = owner.invariants.length > 0 && !member.isStatic || member.hasClause;
    const owes = declaration
        ? participatesInVerification(declaration, member.model) || hooks.owesProof(declaration, context)
        : [...owner.fields.values()].some(field => field.initializer && mayCarryObligations(field.initializer, initialState(member.model, base.logic), context));
    if (!required && !owes) return undefined;
    const usesNumber = !!declaration && (declaration.parameters.some(parameter => parameter.type?.kind === ts.SyntaxKind.NumberKeyword)
        || declaration.type?.kind === ts.SyntaxKind.NumberKeyword);
    if (usesNumber && !member.model.numberModel) {
        if (!required && !participatesInVerification(declaration, member.model)) return undefined;
        diagnostic(context, declaration.name ?? declaration, new Error("A number proof requires numberModel: 'mathematical-real' or 'safe-integer', on the member or its class."));
        rejected.add(declaration);
        return undefined;
    }
    const exitNode: TS.Node = declaration?.body ?? owner.declaration.name!;
    let states: State[];
    try { states = [memberEntryState(owner, member, context)]; }
    catch (error) {
        diagnostic(context, declaration?.name ?? declaration ?? exitNode, error);
        if (declaration) rejected.add(declaration);
        return context.nextTemporary;
    }
    if (declaration?.body) states = hooks.executeStatements(declaration.body.statements, states, context);
    // Falling off the end of the body is a normal exit too.
    const location: Clause = declaration?.body
        ? { value: "}", start: declaration.body.end - 1 }
        : { value: owner.name, start: nodeStart(owner.declaration.name!, base.sourceFile) };
    for (const state of states) {
        try { proveMemberExit(state, exitNode, context, undefined, location); }
        catch (error) { diagnostic(context, declaration?.name ?? declaration ?? exitNode, error); }
    }
    return context.nextTemporary;
}

/** A member's `return`: its value, then what the member owes on exit. */
export function returnFromMember(node: TS.ReturnStatement, state: State, context: Context): State[] {
    context.visited.add(node);
    const model = context.currentMember!.member.model;
    let result: Term | undefined;
    if (node.expression && !lowerObjectCreation(node.expression, state, context)) {
        // As for functions, a value outside the model is fine unless a contract reads it or it hides an obligation.
        if (model.ensures.length || model.returnRefinement) result = hooks.lowerExpression(node.expression, state, context);
        else {
            try { result = hooks.lowerExpression(node.expression, state, context); }
            catch (error) { if (mayCarryObligations(node.expression, state, context)) throw error; }
        }
    }
    proveMemberExit(state, node, context, result);
    return [];
}

/**
 * Postconditions describe normal returns, so a path that throws has nothing left to prove, except that the object
 * outlives an exception its method throws: the invariant must hold then too. A throwing constructor leaves no object.
 */
export function throwFromMember(node: TS.ThrowStatement, state: State, context: Context): State[] {
    const current = context.currentMember;
    if (current && !current.member.isStatic && current.member.kind !== "constructor") {
        proveInvariants(current.owner, state, node, `when ${current.member.name} throws`, context);
    }
    return [];
}

/** `this.field`, which reads the current object; any other use of `this`, and objects created with `new`, are no values. */
export function lowerObjectExpression(node: TS.Expression, state: State, context: Context): Term | undefined {
    if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const key = `this.${ts.idText(node.name)}`;
        const value = state.values[key];
        if (value) return value;
        const sort = state.variables[key];
        if (sort) return { smt: `|${key}|`, sort };
        const owner = context.currentMember?.owner;
        const field = owner?.fields.get(ts.idText(node.name));
        throw new Error(!field ? `'${key}' is not a field proofs can read.`
            : !field.sort ? `Field '${field.name}' of '${owner!.name}' has a type proofs cannot model.`
            : `'${key}' is read before it is assigned.`);
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) throw new Error("'this' is not a value proofs can read.");
    if (ts.isNewExpression(node)) {
        lowerObjectCreation(node, state, context);
        throw new Error("An object is not a value proofs can read.");
    }
    return undefined;
}

/** Whether a write to `key` only stores a value: `this.name` may also name an accessor, whose setter would run. */
export function writesField(key: string, context: Context): boolean {
    return !key.startsWith("this.") || !!context.currentMember?.owner.fields.has(key.slice("this.".length));
}
