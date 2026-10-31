import ts from "typescript";
import type { TSPPAnalysisDiagnostic, TSPPAnalysisSourceFile } from "@tspp/plugin-sdk/compiler";
import { expressionToSmtTerm, type Sort, type Term } from "./expression";
import { maskContractClauses, matchingBrace, parseProperties } from "./contracts";
import type { PendingProof } from "./contracts";
import { collectRefinements, type RefinementModel } from "./refinements";
import type { LogicLibrary } from "./logic";
import {
    collectDataTypes, collectRecordTypes, fieldsFromType, parseFunctionModels,
    refinementFromType, sortFromType, type Clause, type FunctionModel,
} from "./models";
interface State {
    readonly variables: Record<string, Sort>;
    readonly values: Record<string, Term>;
    readonly declarations: Set<string>;
    readonly facts: string[];
}
interface Context {
    readonly fileName: string;
    readonly sourceFile: ts.SourceFile;
    readonly sourceText: string;
    readonly functions: ReadonlyMap<string, FunctionModel>;
    readonly refinements: ReadonlyMap<string, RefinementModel>;
    readonly records: ReadonlyMap<string, ReadonlyMap<string, Sort>>;
    readonly constructors: ReadonlyMap<string, { readonly tag: string; readonly fields: readonly string[]; }>;
    readonly logic: LogicLibrary;
    readonly proofs: PendingProof[];
    readonly diagnostics: TSPPAnalysisDiagnostic[];
    readonly currentFunction?: FunctionModel;
    nextTemporary: number;
}

const cloneState = (state: State): State => ({
    variables: { ...state.variables }, values: { ...state.values },
    declarations: new Set(state.declarations), facts: [...state.facts],
});

function diagnostic(context: Context, node: ts.Node, message: unknown): void {
    context.diagnostics.push({
        fileName: context.fileName, start: node.getStart(context.sourceFile), length: node.getWidth(context.sourceFile),
        code: 19003, category: "error", source: "TS++ verification",
        message: message instanceof Error ? message.message : String(message),
    });
}


function scriptFor(state: State): string {
    return [...state.declarations, ...state.facts.map(fact => `(assert ${fact})`)].join("\n");
}

function addProof(context: Context, state: State, goal: string, node: ts.Node, name: string, location?: Clause): void {
    context.proofs.push({
        query: { script: scriptFor(state), goal }, fileName: context.fileName,
        start: location?.start ?? node.getStart(context.sourceFile),
        length: location?.value.length ?? node.getWidth(context.sourceFile), name,
    });
}

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
    const functionName = node.expression.text;
    const logic = context.logic.functions[functionName];
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
    const sort: Sort = model.returnSort ?? "Int";
    const name = `tspp.call.${model.name}.${context.nextTemporary++}`;
    const result = { smt: `|${name}|`, sort } as const;
    state.declarations.add(`(declare-const |${name}| ${sort})`);
    if (model !== context.currentFunction) {
        for (const ensure of model.ensures) {
            const fact = instantiate(ensure.value, model.parameters, arguments_, context.logic, result, model.numberModel);
            if (fact.sort === "Bool") state.facts.push(fact.smt);
        }
    }
    return result;
}

function lowerStructuredResult(node: ts.Expression, state: State, context: Context): Record<string, Term> | undefined {
    if (ts.isIdentifier(node)) {
        const constructor = context.constructors.get(node.text);
        return constructor ? { "result._tag": { smt: `"${constructor.tag}"`, sort: "String" } } : undefined;
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
        const arithmetic = new Map<number, string>([
            [ts.SyntaxKind.PlusToken, "+"], [ts.SyntaxKind.MinusToken, "-"], [ts.SyntaxKind.AsteriskToken, "*"],
            [ts.SyntaxKind.SlashToken, "tspp.js.trunc.div"], [ts.SyntaxKind.PercentToken, "tspp.js.trunc.rem"],
        ]);
        const comparison = new Map<number, string>([
            [ts.SyntaxKind.LessThanToken, "<"], [ts.SyntaxKind.LessThanEqualsToken, "<="],
            [ts.SyntaxKind.GreaterThanToken, ">"], [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
        ]);
        if (arithmetic.has(operator) && left.sort === right.sort && (left.sort === "Int" || left.sort === "Real")) {
            if (operator === ts.SyntaxKind.PercentToken && left.sort !== "Int") throw new Error("Remainder requires the safe-integer model.");
            if (operator === ts.SyntaxKind.SlashToken && left.sort === "Real") return { smt: `(/ ${left.smt} ${right.smt})`, sort: "Real" };
            if (operator === ts.SyntaxKind.SlashToken || operator === ts.SyntaxKind.PercentToken) {
                addProof(context, state, `(not (= ${right.smt} 0))`, node.right, "division definedness");
            }
            const result = { smt: `(${arithmetic.get(operator)} ${left.smt} ${right.smt})`, sort: left.sort } as Term;
            if (context.currentFunction?.numberModel === "safe-integer"
                && (operator === ts.SyntaxKind.PlusToken || operator === ts.SyntaxKind.MinusToken || operator === ts.SyntaxKind.AsteriskToken)) {
                addProof(context, state, `(and (>= ${result.smt} (- 9007199254740991)) (<= ${result.smt} 9007199254740991))`, node, "safe-integer range");
            }
            return result;
        }
        if (comparison.has(operator) && left.sort === right.sort && (left.sort === "Int" || left.sort === "Real")) return { smt: `(${comparison.get(operator)} ${left.smt} ${right.smt})`, sort: "Bool" };
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

function updateAssignment(node: ts.BinaryExpression, state: State, context: Context): boolean {
    if (!ts.isIdentifier(node.left)) return false;
    const operators = new Map<number, string>([
        [ts.SyntaxKind.EqualsToken, ""], [ts.SyntaxKind.PlusEqualsToken, "+"], [ts.SyntaxKind.MinusEqualsToken, "-"],
        [ts.SyntaxKind.AsteriskEqualsToken, "*"], [ts.SyntaxKind.SlashEqualsToken, "tspp.js.trunc.div"],
        [ts.SyntaxKind.PercentEqualsToken, "tspp.js.trunc.rem"],
    ]);
    const operator = operators.get(node.operatorToken.kind);
    if (operator === undefined) return false;
    const right = lowerExpression(node.right, state, context);
    if (!operator) state.values[node.left.text] = right;
    else {
        const left = lowerExpression(node.left, state, context);
        const result = { smt: `(${operator} ${left.smt} ${right.smt})`, sort: left.sort };
        if (context.currentFunction?.numberModel === "safe-integer"
            && (operator === "+" || operator === "-" || operator === "*")) {
            addProof(context, state, `(and (>= ${result.smt} (- 9007199254740991)) (<= ${result.smt} 9007199254740991))`, node, "safe-integer range");
        }
        state.values[node.left.text] = result;
    }
    return true;
}

function executeStatement(node: ts.Statement, state: State, context: Context): State[] {
    try {
        if (ts.isBlock(node)) return executeStatements(node.statements, [state], context);
        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) continue;
                if (declaration.initializer && ts.isCallExpression(declaration.initializer)
                    && ts.isPropertyAccessExpression(declaration.initializer.expression)
                    && ["definePredicate", "defineFunction", "defineRecursiveFunction", "declareFunction"]
                        .includes(declaration.initializer.expression.name.text)) continue;
                const value = declaration.initializer ? lowerExpression(declaration.initializer, state, context) : undefined;
                const refinement = refinementFromType(declaration.type, context.refinements);
                const sort = sortFromType(declaration.type, context.refinements, context.currentFunction?.numberModel) ?? value?.sort;
                if (sort) state.variables[declaration.name.text] = sort;
                if (value) state.values[declaration.name.text] = value;
                if (value && refinement) {
                    const goal = expressionToSmtTerm(refinement.predicate, { substitutions: { value } });
                    addProof(context, state, goal.smt, declaration.initializer ?? declaration, `${refinement.name} refinement introduction`);
                }
            }
            return [state];
        }
        if (ts.isLabeledStatement(node) && (node.label.text === "assert" || node.label.text === "assume") && ts.isExpressionStatement(node.statement)) {
            const condition = lowerExpression(node.statement.expression, state, context);
            if (condition.sort !== "Bool") throw new Error(`${node.label.text} requires a Boolean expression.`);
            if (node.label.text === "assert") addProof(context, state, condition.smt, node.statement.expression, "local assertion");
            state.facts.push(condition.smt);
            return [state];
        }
        if (ts.isExpressionStatement(node)) {
            if (ts.isCallExpression(node.expression) && ts.isPropertyAccessExpression(node.expression.expression)
                && node.expression.expression.name.text === "axiom") return [state];
            if (ts.isBinaryExpression(node.expression) && updateAssignment(node.expression, state, context)) return [state];
            if (ts.isCallExpression(node.expression)) lowerCall(node.expression, state, context);
            return [state];
        }
        if (ts.isReturnStatement(node) && node.expression) {
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
        return [state];
    }
    catch (error) { diagnostic(context, node, error); return [state]; }
}

function executeSwitch(node: ts.SwitchStatement, state: State, context: Context): State[] {
    const discriminant = lowerExpression(node.expression, state, context);
    const live: State[] = [];
    const excluded: string[] = [];
    for (const clause of node.caseBlock.clauses) {
        const branch = cloneState(state);
        if (ts.isCaseClause(clause)) {
            const value = lowerExpression(clause.expression, branch, context);
            branch.facts.push(`(= ${discriminant.smt} ${value.smt})`);
            excluded.push(`(not (= ${discriminant.smt} ${value.smt}))`);
        }
        else branch.facts.push(...excluded);
        live.push(...executeStatements(clause.statements.filter(statement => !ts.isBreakStatement(statement)), [branch], context));
    }
    return live;
}

function executeStatements(nodes: readonly ts.Statement[], states: State[], context: Context): State[] {
    for (const node of nodes) states = states.flatMap(state => executeStatement(node, state, context));
    return states;
}

function executeWhile(node: ts.WhileStatement, state: State, context: Context): State[] {
    const between = context.sourceText.slice(node.expression.end, node.statement.getStart(context.sourceFile));
    const withOffset = between.indexOf("with");
    if (withOffset < 0) return [state];
    const open = context.sourceText.indexOf("{", node.expression.end + withOffset);
    const close = matchingBrace(context.sourceText, open);
    const invariants = parseProperties(context.sourceText.slice(open + 1, close), open + 1).filter(item => item.name === "invariant");
    const condition = lowerExpression(node.expression, state, context);
    for (const invariant of invariants) {
        const goal = expressionToSmtTerm(invariant.value, { variables: state.variables, substitutions: state.values, functions: context.logic.functions });
        addProof(context, state, goal.smt, node, "loop invariant initialization", invariant);
    }
    const preserved = cloneState(state);
    preserved.facts.push(condition.smt);
    for (const invariant of invariants) {
        const fact = expressionToSmtTerm(invariant.value, { variables: preserved.variables, substitutions: preserved.values, functions: context.logic.functions });
        preserved.facts.push(fact.smt);
    }
    const afterBody = executeStatement(node.statement, preserved, context);
    for (const next of afterBody) {
        for (const invariant of invariants) {
            const goal = expressionToSmtTerm(invariant.value, { variables: next.variables, substitutions: next.values, functions: context.logic.functions });
            addProof(context, next, goal.smt, node, "loop invariant preservation", invariant);
        }
    }
    const exit = cloneState(state);
    const assigned = new Set<string>();
    const visit = (child: ts.Node): void => {
        if (ts.isBinaryExpression(child) && ts.isIdentifier(child.left) && updateOperator(child.operatorToken.kind)) assigned.add(child.left.text);
        ts.forEachChild(child, visit);
    };
    visit(node.statement);
    for (const name of assigned) {
        const sort = exit.variables[name];
        if (!sort) continue;
        const symbol = `tspp.loop.${name}.${context.nextTemporary++}`;
        exit.declarations.add(`(declare-const |${symbol}| ${sort})`);
        exit.values[name] = { smt: `|${symbol}|`, sort };
    }
    for (const invariant of invariants) {
        const fact = expressionToSmtTerm(invariant.value, { variables: exit.variables, substitutions: exit.values, functions: context.logic.functions });
        exit.facts.push(fact.smt);
    }
    const exitCondition = lowerExpression(node.expression, exit, context);
    exit.facts.push(`(not ${exitCondition.smt})`);
    return [exit];
}

function updateOperator(kind: ts.SyntaxKind): boolean {
    return kind === ts.SyntaxKind.EqualsToken || kind === ts.SyntaxKind.PlusEqualsToken
        || kind === ts.SyntaxKind.MinusEqualsToken || kind === ts.SyntaxKind.AsteriskEqualsToken
        || kind === ts.SyntaxKind.SlashEqualsToken || kind === ts.SyntaxKind.PercentEqualsToken;
}

function initialState(model: FunctionModel, logic: LogicLibrary): State {
    const declarations = new Set<string>(logic.declarations);
    for (const [name, sort] of Object.entries(model.variables)) declarations.add(`(declare-const |${name}| ${sort})`);
    const state: State = { variables: { ...model.variables }, values: {}, declarations, facts: [] };
    for (const requirement of model.requires) {
        const fact = expressionToSmtTerm(requirement.value, {
            variables: state.variables,
            functions: logic.functions,
            defaultNumberSort: model.numberModel === "mathematical-real" ? "Real" : "Int",
        });
        if (fact.sort === "Bool") state.facts.push(fact.smt);
    }
    if (model.numberModel === "safe-integer") {
        for (const [name, sort] of Object.entries(model.variables)) {
            if (sort === "Int") state.facts.push(`(and (>= |${name}| (- 9007199254740991)) (<= |${name}| 9007199254740991))`);
        }
    }
    for (const [name, refinement] of Object.entries(model.parameterRefinements ?? {})) {
        const fact = expressionToSmtTerm(refinement.predicate, {
            substitutions: { value: { smt: `|${name}|`, sort: refinement.sort } },
            functions: logic.functions,
        });
        if (fact.sort === "Bool") state.facts.push(fact.smt);
    }
    return state;
}

export function collectProgramProofs(
    source: TSPPAnalysisSourceFile, diagnostics: TSPPAnalysisDiagnostic[], logic: LogicLibrary,
): PendingProof[] {
    const masked = maskContractClauses(source.fileName, source.text, false);
    const sourceFile = ts.createSourceFile(source.fileName, masked, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = parseFunctionModels(source.text);
    const refinements = collectRefinements(source.text);
    const records = collectRecordTypes(sourceFile);
    const constructors = collectDataTypes(source.text, records);
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
            const sort = sortFromType(parameter.type, refinements, existing?.numberModel);
            if (sort) {
                parameters.push(parameter.name.text);
                variables[parameter.name.text] = sort;
                const refinement = refinementFromType(parameter.type, refinements);
                if (refinement) parameterRefinements[parameter.name.text] = refinement;
            }
            else {
                for (const [field, fieldSort] of fieldsFromType(parameter.type, records, existing?.numberModel) ?? []) {
                    variables[`${parameter.name.text}.${field}`] = fieldSort;
                }
            }
        }
        functions.set(statement.name.text, {
            name: statement.name.text, parameters, variables,
            requires: existing?.requires ?? [], ensures: existing?.ensures ?? [],
            bodyStart: statement.body?.getStart(sourceFile) ?? statement.end,
            parameterRefinements,
            returnRefinement: refinementFromType(statement.type, refinements),
            numberModel: existing?.numberModel,
            returnSort: sortFromType(statement.type, refinements, existing?.numberModel),
        });
    }
    const proofs: PendingProof[] = [];
    const base: Omit<Context, "currentFunction"> = {
        fileName: source.fileName, sourceFile, sourceText: source.text, functions, refinements, records, constructors,
        logic, proofs, diagnostics, nextTemporary: 0,
    };
    for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
        if (isMacroFunction(statement, source.text, sourceFile)) continue;
        const model = functions.get(statement.name.text);
        if (!model) continue;
        const context: Context = { ...base, currentFunction: model };
        const usesNumber = statement.parameters.some(parameter => parameter.type?.kind === ts.SyntaxKind.NumberKeyword)
            || statement.type?.kind === ts.SyntaxKind.NumberKeyword;
        if (usesNumber && !model.numberModel) {
            diagnostic(context, statement.name, new Error("A number proof requires numberModel: 'mathematical-real' or 'safe-integer'."));
            continue;
        }
        executeStatements(statement.body.statements, [initialState(model, logic)], context);
        base.nextTemporary = context.nextTemporary;
    }
    const topLevelState: State = { variables: {}, values: {}, declarations: new Set(logic.declarations), facts: [] };
    const proofVariables = collectTopLevelProofVariables(sourceFile, refinements);
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration =>
            ts.isIdentifier(declaration.name) && proofVariables.has(declaration.name.text)
        ) || ts.isLabeledStatement(statement) && statement.label.text === "assert") {
            executeStatement(statement, topLevelState, base as Context);
        }
    }
    const visitCalls = (node: ts.Node): void => {
        if (ts.isFunctionLike(node)) return;
        if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && functions.has(node.expression.text)) {
            try { lowerCall(node, topLevelState, base as Context); } catch (error) { diagnostic(base as Context, node, error); }
        }
        ts.forEachChild(node, visitCalls);
    };
    sourceFile.statements.forEach(visitCalls);
    return proofs;
}

function isMacroFunction(statement: ts.FunctionDeclaration, sourceText: string, sourceFile: ts.SourceFile): boolean {
    const headerEnd = statement.body?.getStart(sourceFile) ?? statement.end;
    const headerStart = Math.max(0, statement.getStart(sourceFile) - 32);
    return /\bmacro\s+function\b/.test(sourceText.slice(headerStart, headerEnd));
}

function collectTopLevelProofVariables(
    sourceFile: ts.SourceFile,
    refinements: ReadonlyMap<string, RefinementModel>,
): ReadonlySet<string> {
    const needed = new Set<string>();
    const declarations = new Map<string, ts.VariableDeclaration>();
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) continue;
                declarations.set(declaration.name.text, declaration);
                if (refinementFromType(declaration.type, refinements)) needed.add(declaration.name.text);
            }
        }
        else if (ts.isLabeledStatement(statement) && statement.label.text === "assert") {
            collectIdentifiers(statement.statement, needed);
        }
    }
    const pending = [...needed];
    while (pending.length) {
        const declaration = declarations.get(pending.pop()!);
        if (!declaration?.initializer) continue;
        const dependencies = new Set<string>();
        collectIdentifiers(declaration.initializer, dependencies);
        for (const dependency of dependencies) {
            if (needed.has(dependency)) continue;
            needed.add(dependency);
            pending.push(dependency);
        }
    }
    return needed;
}

function collectIdentifiers(node: ts.Node, names: Set<string>): void {
    if (ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node.parent)) names.add(node.text);
    ts.forEachChild(node, child => collectIdentifiers(child, names));
}
