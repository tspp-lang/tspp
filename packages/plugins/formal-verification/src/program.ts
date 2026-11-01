import ts from "typescript";
import type { TSPPAnalysisDiagnostic, TSPPAnalysisSourceFile } from "@tspp/plugin-sdk/compiler";
import { expressionToSmtTerm, type Sort, type Term } from "./expression";
import { matchingBrace, reportWithClauseIssues, parseProperties } from "./contracts";
import type { PendingProof } from "./contracts";
import type { RefinementModel } from "./refinements";
import type { LogicLibrary } from "./logic";
import { collectTopLevelProofVariables, isMacroFunction } from "./proof-scope";
import {
    fieldsFromType, participatesInVerification, refinementFromType, sortFromType, type Clause, type FunctionModel,
} from "./models";
import { prepareVerificationSource } from "./source-cache";
import {
    addProof, assignedKeys, assignmentKey, assignmentOperators, arithmeticOperators, cloneState, comparisonOperators,
    diagnostic, havoc, innermostLoop, isBound, isIncrementOrDecrement, lexicalNames, safeIntegerRange, unsupported,
    initialState, type Context, type JumpTarget, type State,
} from "./execution-state";
import { countTopLevelWrites, countWrites, reportUnvisited } from "./coverage";

function instantiate(
    clause: string, names: readonly string[], values: readonly Term[], logic: LogicLibrary,
    result?: Term, numberModel?: FunctionModel["numberModel"],
): Term {
    const substitutions: Record<string, Term> = {};
    names.forEach((name, index) => substitutions[name] = values[index]);
    if (result) substitutions.result = result;
    return expressionToSmtTerm(clause, {
        substitutions, functions: logic.functions,
        defaultNumberSort: numberModel === "mathematical-real" ? "Real" : "Int",
    });
}

function lowerCall(node: ts.CallExpression, state: State, context: Context): Term {
    if (!ts.isIdentifier(node.expression)) throw new Error("Only direct calls can participate in formal verification.");
    context.visited.add(node);
    const functionName = node.expression.text;
    // A function declared in this file shadows a project-wide logic function of the same name.
    const logic = context.functions.has(functionName) ? undefined : context.logic.functions[functionName];
    if (logic) {
        const arguments_ = node.arguments.map(argument => lowerExpression(argument, state, context));
        if (arguments_.length !== logic.parameters.length) throw new Error(`'${functionName}' expects ${logic.parameters.length} arguments.`);
        logic.parameters.forEach((sort, index) => {
            if (arguments_[index].sort !== sort) throw new Error(`Argument ${index + 1} of '${functionName}' must be ${sort}.`);
        });
        return { smt: `(|${functionName}|${arguments_.length ? ` ${arguments_.map(argument => argument.smt).join(" ")}` : ""})`, sort: logic.result };
    }
    const model = context.functions.get(node.expression.text);
    if (!model) throw new Error(`Call to unsupported function '${node.expression.text}'.`);
    if (node.arguments.length !== model.parameters.length) throw new Error(`'${model.name}' expects ${model.parameters.length} arguments.`);
    const argumentContext = context.currentFunction ? context : { ...context, currentFunction: model };
    const arguments_ = node.arguments.map(argument => lowerExpression(argument, state, argumentContext));
    for (const requirement of model.requires) {
        const goal = instantiate(requirement.value, model.parameters, arguments_, context.logic, undefined, model.numberModel);
        if (goal.sort !== "Bool") throw new Error(`The precondition of '${model.name}' is not Boolean.`);
        addProof(context, state, goal.smt, node, `${model.name} call precondition`);
    }
    for (const [parameter, refinement] of Object.entries(model.parameterRefinements ?? {})) {
        const index = model.parameters.indexOf(parameter);
        if (index < 0) continue;
        const goal = expressionToSmtTerm(refinement.predicate, { substitutions: { value: arguments_[index] }, functions: context.logic.functions });
        addProof(context, state, goal.smt, node.arguments[index], `${refinement.name} argument refinement`);
    }
    const sort: Sort = model.returnSort ?? "Int";
    const name = `tspp.call.${model.name}.${context.nextTemporary++}`;
    const result = { smt: `|${name}|`, sort } as const;
    state.declarations.add(`(declare-const |${name}| ${sort})`);
    if (model !== context.currentFunction) {
        for (const ensure of model.ensures) {
            const fact = instantiate(ensure.value, model.parameters, arguments_, context.logic, result, model.numberModel);
            if (fact.sort === "Bool") state.facts.push(fact.smt);
        }
        if (model.returnRefinement) {
            const fact = expressionToSmtTerm(model.returnRefinement.predicate, { substitutions: { value: result }, functions: context.logic.functions });
            if (fact.sort === "Bool") state.facts.push(fact.smt);
        }
    }
    return result;
}

function lowerStructuredResult(node: ts.Expression, state: State, context: Context): Record<string, Term> | undefined {
    if (ts.isParenthesizedExpression(node)) return lowerStructuredResult(node.expression, state, context);
    if (ts.isIdentifier(node)) {
        const constructor = context.constructors.get(node.text);
        if (constructor) return { "result._tag": { smt: `"${constructor.tag}"`, sort: "String" } };
        // Returning a record parameter returns each of its fields.
        const prefix = `${node.text}.`;
        const fields = Object.keys({ ...state.variables, ...state.values }).filter(key => key.startsWith(prefix));
        if (!fields.length) return undefined;
        return Object.fromEntries(fields.map(key => [`result.${key.slice(prefix.length)}`, lowerFieldKey(key, state)]));
    }
    if (ts.isObjectLiteralExpression(node)) {
        const result: Record<string, Term> = {};
        for (const property of node.properties) {
            if (ts.isShorthandPropertyAssignment(property)) result[`result.${property.name.text}`] = lowerExpression(property.name, state, context);
            else if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
                result[`result.${property.name.text}`] = lowerExpression(property.initializer, state, context);
            }
            else return undefined;
        }
        return result;
    }
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return undefined;
    const constructor = context.constructors.get(node.expression.text);
    if (!constructor || constructor.fields.length !== node.arguments.length) return undefined;
    const result: Record<string, Term> = { "result._tag": { smt: `"${constructor.tag}"`, sort: "String" } };
    constructor.fields.forEach((field, index) => {
        try { result[`result.${field}`] = lowerExpression(node.arguments[index], state, context); }
        catch { /* Recursive fields need no scalar SMT binding until selected. */ }
    });
    return result;
}

function lowerFieldKey(key: string, state: State): Term {
    return state.values[key] ?? { smt: `|${key}|`, sort: state.variables[key] };
}

function lowerExpression(node: ts.Expression, state: State, context: Context): Term {
    if (ts.isParenthesizedExpression(node)) return lowerExpression(node.expression, state, context);
    if (ts.isIdentifier(node)) {
        if (node.text === "true" || node.text === "false") return { smt: node.text, sort: "Bool" };
        const value = state.values[node.text];
        if (value) return value;
        const sort = state.variables[node.text];
        if (!sort) throw new Error(`Unknown proof variable '${node.text}'.`);
        return { smt: `|${node.text}|`, sort };
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        const name = `${node.expression.text}.${node.name.text}`;
        const value = state.values[name];
        if (value) return value;
        const sort = state.variables[name];
        if (!sort) throw new Error(`Unknown proof field '${name}'.`);
        return { smt: `|${name}|`, sort };
    }
    if (ts.isBigIntLiteral(node)) return { smt: node.text.replace(/n$/, ""), sort: "Int" };
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return { smt: `"${node.text.replace(/"/g, '""')}"`, sort: "String" };
    }
    if (ts.isNumericLiteral(node)) {
        const model = context.currentFunction?.numberModel;
        if (!context.currentFunction) return { smt: node.text, sort: "Int" };
        if (!model) throw new Error("A number proof requires numberModel: 'mathematical-real' or 'safe-integer'.");
        if (model === "safe-integer" && !(/^\d+$/.test(node.text) && Number(node.text) <= Number.MAX_SAFE_INTEGER)) {
            throw new Error(`Numeric literal '${node.text}' is not a safe integer.`);
        }
        return { smt: node.text, sort: model === "mathematical-real" ? "Real" : "Int" };
    }
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
        return { smt: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false", sort: "Bool" };
    }
    if (ts.isPrefixUnaryExpression(node)) {
        const operand = lowerExpression(node.operand, state, context);
        if (node.operator === ts.SyntaxKind.ExclamationToken && operand.sort === "Bool") return { smt: `(not ${operand.smt})`, sort: "Bool" };
        if (node.operator === ts.SyntaxKind.MinusToken && (operand.sort === "Int" || operand.sort === "Real")) return { smt: `(- ${operand.smt})`, sort: operand.sort };
        throw new Error("Unsupported unary proof expression.");
    }
    if (ts.isCallExpression(node)) return lowerCall(node, state, context);
    if (ts.isBinaryExpression(node)) {
        const left = lowerExpression(node.left, state, context);
        const right = lowerExpression(node.right, state, context);
        const operator = node.operatorToken.kind;
        if (arithmeticOperators.has(operator) && left.sort === right.sort && (left.sort === "Int" || left.sort === "Real")) {
            return lowerArithmetic(operator, left, right, node, node.right, state, context);
        }
        if (comparisonOperators.has(operator) && left.sort === right.sort && (left.sort === "Int" || left.sort === "Real")) return { smt: `(${comparisonOperators.get(operator)} ${left.smt} ${right.smt})`, sort: "Bool" };
        if (operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
            if (left.sort !== right.sort) throw new Error("Both sides of equality must have the same proof sort.");
            const equal = `(= ${left.smt} ${right.smt})`;
            return { smt: operator === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : `(not ${equal})`, sort: "Bool" };
        }
        if (operator === ts.SyntaxKind.AmpersandAmpersandToken && left.sort === "Bool" && right.sort === "Bool") return { smt: `(and ${left.smt} ${right.smt})`, sort: "Bool" };
        if (operator === ts.SyntaxKind.BarBarToken && left.sort === "Bool" && right.sort === "Bool") return { smt: `(or ${left.smt} ${right.smt})`, sort: "Bool" };
        throw new Error("Unsupported binary proof expression or incompatible sorts.");
    }
    throw new Error(`Unsupported proof expression '${node.getText(context.sourceFile)}'.`);
}

function lowerArithmetic(
    operator: ts.SyntaxKind, left: Term, right: Term, node: ts.Node, rightNode: ts.Node, state: State, context: Context,
): Term {
    if (left.sort !== right.sort || (left.sort !== "Int" && left.sort !== "Real")) throw new Error("Arithmetic operands must have the same numeric sort.");
    if (operator === ts.SyntaxKind.PercentToken && left.sort !== "Int") throw new Error("Remainder requires the safe-integer model.");
    if (operator === ts.SyntaxKind.SlashToken || operator === ts.SyntaxKind.PercentToken) {
        addProof(context, state, `(not (= ${right.smt} 0))`, rightNode, "division definedness");
    }
    if (operator === ts.SyntaxKind.SlashToken && left.sort === "Real") return { smt: `(/ ${left.smt} ${right.smt})`, sort: "Real" };
    const safeInteger = context.currentFunction?.numberModel === "safe-integer";
    // JavaScript number division is exact, so the truncating integer model only matches when nothing is truncated.
    if (operator === ts.SyntaxKind.SlashToken && safeInteger) {
        addProof(context, state, `(= (tspp.js.trunc.rem ${left.smt} ${right.smt}) 0)`, node, "safe-integer exact division");
    }
    const result: Term = { smt: `(${arithmeticOperators.get(operator)} ${left.smt} ${right.smt})`, sort: left.sort };
    if (safeInteger && (operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.AsteriskToken)) {
        addProof(context, state, safeIntegerRange(result.smt), node, "safe-integer range");
    }
    return result;
}

function updateAssignment(node: ts.BinaryExpression, state: State, context: Context): boolean {
    const key = assignmentKey(node.left);
    if (!key || !assignmentOperators.has(node.operatorToken.kind)) return false;
    const operator = assignmentOperators.get(node.operatorToken.kind);
    const right = lowerExpression(node.right, state, context);
    state.values[key] = operator === undefined ? right
        : lowerArithmetic(operator, lowerExpression(node.left, state, context), right, node, node.right, state, context);
    return true;
}

function updateIncrement(node: ts.PrefixUnaryExpression | ts.PostfixUnaryExpression, state: State, context: Context): boolean {
    const key = assignmentKey(node.operand);
    if (!key) return false;
    const current = lowerExpression(node.operand, state, context);
    const one: Term = { smt: current.sort === "Real" ? "1.0" : "1", sort: current.sort };
    const operator = node.operator === ts.SyntaxKind.PlusPlusToken ? ts.SyntaxKind.PlusToken : ts.SyntaxKind.MinusToken;
    state.values[key] = lowerArithmetic(operator, current, one, node, node, state, context);
    return true;
}

function executeStatement(node: ts.Statement, state: State, context: Context): State[] {
    try {
        if (ts.isBlock(node)) {
            const scoped = lexicalNames(node.statements).filter(name => !isBound(state, name));
            const after = executeStatements(node.statements, [state], context);
            for (const next of after) {
                for (const name of scoped) { delete next.values[name]; delete next.variables[name]; }
            }
            return after;
        }
        if (ts.isVariableStatement(node)) {
            const lexical = (node.declarationList.flags & ts.NodeFlags.BlockScoped) !== 0;
            for (const declaration of node.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) return unsupported(state, declaration, context);
                if (declaration.initializer && ts.isCallExpression(declaration.initializer)
                    && ts.isPropertyAccessExpression(declaration.initializer.expression)
                    && ["definePredicate", "defineFunction", "defineRecursiveFunction", "declareFunction"]
                        .includes(declaration.initializer.expression.name.text)) continue;
                // A shadowing binding would overwrite the outer value that later code still reads.
                if (lexical && isBound(state, declaration.name.text)) unsupported(state, declaration, context);
                const value = declaration.initializer ? lowerExpression(declaration.initializer, state, context) : undefined;
                const refinement = refinementFromType(declaration.type, context.refinements);
                const sort = refinement?.sort
                    ?? sortFromType(declaration.type, context.refinements, context.currentFunction?.numberModel)
                    ?? value?.sort;
                if (sort) state.variables[declaration.name.text] = sort;
                if (value) state.values[declaration.name.text] = value;
                if (value && refinement) {
                    const goal = expressionToSmtTerm(refinement.predicate, { substitutions: { value } });
                    addProof(context, state, goal.smt, declaration.initializer ?? declaration, `${refinement.name} refinement introduction`);
                }
            }
            return [state];
        }
        if (ts.isLabeledStatement(node) && (node.label.text === "assert" || node.label.text === "assume")) {
            context.visited.add(node);
            if (!ts.isExpressionStatement(node.statement)) return unsupported(state, node, context);
            const condition = lowerExpression(node.statement.expression, state, context);
            if (condition.sort !== "Bool") throw new Error(`${node.label.text} requires a Boolean expression.`);
            if (node.label.text === "assert") addProof(context, state, condition.smt, node.statement.expression, "local assertion");
            state.facts.push(condition.smt);
            return [state];
        }
        if (ts.isExpressionStatement(node)) {
            let expression = node.expression;
            while (ts.isParenthesizedExpression(expression)) expression = expression.expression;
            if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
                && expression.expression.name.text === "axiom") return [state];
            if (ts.isBinaryExpression(expression) && assignmentOperators.has(expression.operatorToken.kind)) {
                return updateAssignment(expression, state, context) ? [state] : unsupported(state, node, context);
            }
            if (isIncrementOrDecrement(expression)) return updateIncrement(expression, state, context) ? [state] : unsupported(state, node, context);
            if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
                && (context.functions.has(expression.expression.text) || context.logic.functions[expression.expression.text])) {
                lowerCall(expression, state, context);
                return [state];
            }
            if (ts.isStringLiteral(expression)) return [state];
            // Unknown calls and other side effects may change anything the proof tracks.
            return unsupported(state, node, context);
        }
        if (ts.isReturnStatement(node)) {
            context.visited.add(node);
            if (!node.expression) {
                if (context.currentFunction?.ensures.length || context.currentFunction?.returnRefinement) {
                    throw new Error("A function with a postcondition must return a value.");
                }
                return [];
            }
            const structured = lowerStructuredResult(node.expression, state, context);
            const result = structured ? undefined : lowerExpression(node.expression, state, context);
            for (const ensure of context.currentFunction?.ensures ?? []) {
                const substitutions = { ...state.values, ...structured, ...(result ? { result } : {}) };
                const goal = expressionToSmtTerm(ensure.value, {
                    variables: state.variables, substitutions,
                    functions: context.logic.functions,
                    defaultNumberSort: context.currentFunction?.numberModel === "mathematical-real" ? "Real" : "Int",
                });
                if (goal.sort !== "Bool") throw new Error("A postcondition must be Boolean.");
                addProof(context, state, goal.smt, node.expression, `${context.currentFunction?.name} postcondition`, ensure);
            }
            const refinement = context.currentFunction?.returnRefinement;
            if (refinement && result) {
                const goal = expressionToSmtTerm(refinement.predicate, { substitutions: { value: result }, functions: context.logic.functions });
                addProof(context, state, goal.smt, node.expression, `${refinement.name} return refinement`);
            }
            return [];
        }
        // Postconditions describe normal returns, so a path that throws has nothing left to prove.
        if (ts.isThrowStatement(node)) return [];
        if (ts.isIfStatement(node)) {
            const condition = lowerExpression(node.expression, state, context);
            if (condition.sort !== "Bool") throw new Error("An if condition must be Boolean.");
            const whenTrue = cloneState(state); whenTrue.facts.push(condition.smt);
            const whenFalse = cloneState(state); whenFalse.facts.push(`(not ${condition.smt})`);
            return [
                ...executeStatement(node.thenStatement, whenTrue, context),
                ...(node.elseStatement ? executeStatement(node.elseStatement, whenFalse, context) : [whenFalse]),
            ];
        }
        if (ts.isSwitchStatement(node)) return executeSwitch(node, state, context);
        if (ts.isWhileStatement(node)) return executeWhile(node, state, context);
        if (ts.isBreakStatement(node) || ts.isContinueStatement(node)) {
            const target = node.label ? undefined : ts.isBreakStatement(node)
                ? context.jumpTargets[context.jumpTargets.length - 1]
                : innermostLoop(context);
            if (!target) return unsupported(state, node, context);
            (ts.isBreakStatement(node) ? target.breaks : target.continues).push(state);
            return [];
        }
        if (ts.isEmptyStatement(node) || ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node)
            || ts.isInterfaceDeclaration(node)) return [state];
        return unsupported(state, node, context);
    }
    catch (error) { diagnostic(context, node, error); return [state]; }
}

/** Follows JavaScript switch semantics: first matching case, fallthrough, and the no-match path. */
function executeSwitch(node: ts.SwitchStatement, state: State, context: Context): State[] {
    const discriminant = lowerExpression(node.expression, state, context);
    const clauses = node.caseBlock.clauses;
    const matches = clauses.map(clause => {
        if (!ts.isCaseClause(clause)) return undefined;
        const value = lowerExpression(clause.expression, state, context);
        if (value.sort !== discriminant.sort) throw new Error("A case value must have the same proof sort as the switch expression.");
        return `(= ${discriminant.smt} ${value.smt})`;
    });
    const misses = (until: number) => matches.slice(0, until).flatMap(match => match ? [`(not ${match})`] : []);
    const scoped = lexicalNames(clauses.flatMap(clause => clause.statements)).filter(name => !isBound(state, name));
    const target: JumpTarget = { kind: "switch", breaks: [], continues: [] };
    let falling: State[] = [];
    context.jumpTargets.push(target);
    try {
        clauses.forEach((clause, index) => {
            const entry = cloneState(state);
            const match = matches[index];
            entry.facts.push(...(match ? [...misses(index), match] : misses(clauses.length)));
            falling = executeStatements(clause.statements, [entry, ...falling], context);
        });
    }
    finally { context.jumpTargets.pop(); }
    const exits = [...falling, ...target.breaks];
    if (!matches.includes(undefined)) {
        const none = cloneState(state);
        none.facts.push(...misses(clauses.length));
        exits.push(none);
    }
    for (const next of exits) {
        for (const name of scoped) { delete next.values[name]; delete next.variables[name]; }
    }
    // Continues inside the switch belong to an enclosing loop.
    innermostLoop(context)?.continues.push(...target.continues);
    return exits;
}

function executeStatements(nodes: readonly ts.Statement[], states: State[], context: Context): State[] {
    for (const node of nodes) states = states.flatMap(state => executeStatement(node, state, context));
    return states;
}

function loopInvariants(node: ts.WhileStatement, context: Context): Clause[] {
    const between = context.sourceText.slice(node.expression.end, node.statement.getStart(context.sourceFile));
    const withOffset = between.indexOf("with");
    if (withOffset < 0) return [];
    const open = context.sourceText.indexOf("{", node.expression.end + withOffset);
    const close = matchingBrace(context.sourceText, open);
    return parseProperties(context.sourceText.slice(open + 1, close), open + 1).filter(item => item.name === "invariant");
}

/**
 * Checks the invariant on entry, proves the body preserves it from an arbitrary iteration, and leaves the loop
 * with only the invariant and the negated condition known. A loop without `with` uses the invariant `true`.
 */
function executeWhile(node: ts.WhileStatement, state: State, context: Context): State[] {
    const invariants = loopInvariants(node, context);
    const invariantTerm = (clause: Clause, current: State) => expressionToSmtTerm(clause.value, {
        variables: current.variables, substitutions: current.values, functions: context.logic.functions,
    });
    for (const invariant of invariants) {
        addProof(context, state, invariantTerm(invariant, state).smt, node, "loop invariant initialization", invariant);
    }
    const iteration = cloneState(state);
    for (const key of assignedKeys(node)) havoc(iteration, key, context);
    for (const invariant of invariants) iteration.facts.push(invariantTerm(invariant, iteration).smt);

    const body = cloneState(iteration);
    body.facts.push(lowerExpression(node.expression, body, context).smt);
    const target: JumpTarget = { kind: "loop", breaks: [], continues: [] };
    let afterBody: State[];
    context.jumpTargets.push(target);
    try { afterBody = executeStatement(node.statement, body, context); }
    finally { context.jumpTargets.pop(); }
    for (const next of [...afterBody, ...target.continues]) {
        for (const invariant of invariants) {
            addProof(context, next, invariantTerm(invariant, next).smt, node, "loop invariant preservation", invariant);
        }
    }

    const exit = cloneState(iteration);
    exit.facts.push(`(not ${lowerExpression(node.expression, exit, context).smt})`);
    // The havoc only covers what the body assigns syntactically; an unmodeled body may have changed more.
    exit.unsupported ??= [...afterBody, ...target.continues, ...target.breaks].find(next => next.unsupported)?.unsupported;
    return [exit, ...target.breaks];
}

export function collectProgramProofs(
    source: TSPPAnalysisSourceFile, diagnostics: TSPPAnalysisDiagnostic[], logic: LogicLibrary,
): PendingProof[] {
    reportWithClauseIssues(source.fileName, source.text, diagnostics);
    const prepared = prepareVerificationSource(source);
    const { sourceFile, refinements, records, constructors } = prepared;
    const functions = new Map(prepared.functions);
    for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
        if (isMacroFunction(statement, source.text, sourceFile)) {
            functions.delete(statement.name.text);
            continue;
        }
        const existing = functions.get(statement.name.text);
        const variables: Record<string, Sort> = {};
        const parameters: string[] = [];
        const parameterRefinements: Record<string, RefinementModel> = {};
        for (const parameter of statement.parameters) {
            if (!ts.isIdentifier(parameter.name)) continue;
            const refinement = refinementFromType(parameter.type, refinements);
            const sort = refinement?.sort ?? sortFromType(parameter.type, refinements, existing?.numberModel);
            if (sort) {
                parameters.push(parameter.name.text);
                variables[parameter.name.text] = sort;
                if (refinement) parameterRefinements[parameter.name.text] = refinement;
            }
            else {
                for (const [field, fieldSort] of fieldsFromType(parameter.type, records, existing?.numberModel) ?? []) {
                    variables[`${parameter.name.text}.${field}`] = fieldSort;
                }
            }
        }
        const returnRefinement = refinementFromType(statement.type, refinements);
        functions.set(statement.name.text, {
            name: statement.name.text, parameters, variables,
            requires: existing?.requires ?? [], ensures: existing?.ensures ?? [],
            bodyStart: statement.body?.getStart(sourceFile) ?? statement.end,
            parameterRefinements,
            returnRefinement,
            numberModel: existing?.numberModel,
            returnSort: returnRefinement?.sort ?? sortFromType(statement.type, refinements, existing?.numberModel),
        });
    }
    const proofs: PendingProof[] = [];
    const base: Omit<Context, "currentFunction"> = {
        fileName: source.fileName, sourceFile, sourceText: source.text, functions, refinements, records, constructors,
        logic, proofs, diagnostics, visited: new Set(), jumpTargets: [], nextTemporary: 0,
    };
    const rejected = new Set<ts.Node>();
    for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
        if (isMacroFunction(statement, source.text, sourceFile)) continue;
        const model = functions.get(statement.name.text);
        if (!model) continue;
        const context: Context = { ...base, currentFunction: model };
        const usesNumber = statement.parameters.some(parameter => parameter.type?.kind === ts.SyntaxKind.NumberKeyword)
            || statement.type?.kind === ts.SyntaxKind.NumberKeyword;
        // Ordinary number code is left alone; any proof obligation inside it is reported as unverified coverage.
        if (usesNumber && !model.numberModel && !participatesInVerification(statement, model)) continue;
        if (usesNumber && !model.numberModel) {
            diagnostic(context, statement.name, new Error("A number proof requires numberModel: 'mathematical-real' or 'safe-integer'."));
            rejected.add(statement);
            continue;
        }
        executeStatements(statement.body.statements, [initialState(model, logic)], context);
        base.nextTemporary = context.nextTemporary;
    }
    const topLevelState: State = { variables: {}, values: {}, declarations: new Set(logic.declarations), facts: [] };
    const proofVariables = collectTopLevelProofVariables(sourceFile, refinements);
    const writesProofVariable = (statement: ts.Statement) => ts.isExpressionStatement(statement)
        && [...assignedKeys(statement)].some(key => proofVariables.has(key.split(".")[0]));
    // Top-level writes run in source order; any other write (in a branch, loop, or function) makes the value unknown.
    const unstable = new Set([...proofVariables].filter(name => countWrites(sourceFile, name) > countTopLevelWrites(sourceFile, name)));
    for (const statement of sourceFile.statements) {
        const declaresProofVariable = ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
            ts.isIdentifier(declaration.name) && proofVariables.has(declaration.name.text));
        const isProofLabel = ts.isLabeledStatement(statement) && (statement.label.text === "assert" || statement.label.text === "assume");
        if (!declaresProofVariable && !isProofLabel && !writesProofVariable(statement)) continue;
        executeStatement(statement, topLevelState, base as Context);
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (ts.isIdentifier(declaration.name) && unstable.has(declaration.name.text)) havoc(topLevelState, declaration.name.text, base as Context);
            }
        }
    }
    const participants = new Set(sourceFile.statements.filter(ts.isFunctionDeclaration).flatMap(statement => {
        const model = statement.name && functions.get(statement.name.text);
        return model && participatesInVerification(statement, model) ? [model.name] : [];
    }));
    const visitCalls = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && participants.has(node.expression.text)) {
            try { lowerCall(node, topLevelState, base as Context); } catch (error) { diagnostic(base as Context, node, error); }
        }
        ts.forEachChild(node, visitCalls);
    };
    sourceFile.statements.forEach(visitCalls);
    reportUnvisited(sourceFile, base as Context, rejected, source.text);
    return proofs;
}
