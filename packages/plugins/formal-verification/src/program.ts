import ts from "typescript";
import type { TSPPAnalysisDiagnostic, TSPPAnalysisSourceFile } from "@tspp/plugin-sdk/compiler";
import { expressionToSmtTerm, type Sort, type Term } from "./expression";
import { maskContractClauses, matchingBrace, parseProperties } from "./contracts";
import type { PendingProof } from "./contracts";
import { collectRefinements, type RefinementModel } from "./refinements";

interface Clause { readonly value: string; readonly start: number; }
interface FunctionModel {
    readonly name: string;
    readonly parameters: readonly string[];
    readonly variables: Readonly<Record<string, Sort>>;
    readonly requires: readonly Clause[];
    readonly ensures: readonly Clause[];
    readonly bodyStart: number;
    readonly parameterRefinements?: Readonly<Record<string, RefinementModel>>;
    readonly returnRefinement?: RefinementModel;
}
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

function refinementFromType(type: ts.TypeNode | undefined, refinements: ReadonlyMap<string, RefinementModel>): RefinementModel | undefined {
    return type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? refinements.get(type.typeName.text) : undefined;
}

function sortFromType(type: ts.TypeNode | undefined, refinements: ReadonlyMap<string, RefinementModel> = new Map()): Sort | undefined {
    if (!type) return undefined;
    if (type.kind === ts.SyntaxKind.BooleanKeyword) return "Bool";
    if (type.kind === ts.SyntaxKind.BigIntKeyword || type.kind === ts.SyntaxKind.NumberKeyword) return "Int";
    return refinementFromType(type, refinements)?.sort;
}

function parseFunctionModels(sourceText: string): Map<string, FunctionModel> {
    const models = new Map<string, FunctionModel>();
    const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*with\s*\{/g;
    for (let match; (match = pattern.exec(sourceText));) {
        const open = sourceText.indexOf("{", match.index + match[0].lastIndexOf("with"));
        const close = matchingBrace(sourceText, open);
        if (close < 0) continue;
        const bodyStart = sourceText.indexOf("{", close + 1);
        const variables: Record<string, Sort> = {};
        const parameters: string[] = [];
        const parameterPattern = /\b([A-Za-z_$][\w$]*)\s*:\s*(boolean|bigint|number)\b/g;
        for (let parameter; (parameter = parameterPattern.exec(match[2]));) {
            parameters.push(parameter[1]);
            variables[parameter[1]] = parameter[2] === "boolean" ? "Bool" : "Int";
        }
        const properties = parseProperties(sourceText.slice(open + 1, close), open + 1);
        models.set(match[1], {
            name: match[1], parameters, variables,
            requires: properties.filter(item => item.name === "requires"),
            ensures: properties.filter(item => item.name === "ensures"), bodyStart,
        });
        pattern.lastIndex = close + 1;
    }
    return models;
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

function instantiate(clause: string, names: readonly string[], values: readonly Term[], result?: Term): Term {
    const substitutions: Record<string, Term> = {};
    names.forEach((name, index) => substitutions[name] = values[index]);
    if (result) substitutions.result = result;
    return expressionToSmtTerm(clause, { substitutions });
}

function lowerCall(node: ts.CallExpression, state: State, context: Context): Term {
    if (!ts.isIdentifier(node.expression)) throw new Error("Only direct calls can participate in formal verification.");
    const model = context.functions.get(node.expression.text);
    if (!model) throw new Error(`Call to unsupported function '${node.expression.text}'.`);
    if (node.arguments.length !== model.parameters.length) throw new Error(`'${model.name}' expects ${model.parameters.length} arguments.`);
    const arguments_ = node.arguments.map(argument => lowerExpression(argument, state, context));
    for (const requirement of model.requires) {
        const goal = instantiate(requirement.value, model.parameters, arguments_);
        if (goal.sort !== "Bool") throw new Error(`The precondition of '${model.name}' is not Boolean.`);
        addProof(context, state, goal.smt, node, `${model.name} call precondition`);
    }
    const sort: Sort = "Int";
    const name = `tspp.call.${model.name}.${context.nextTemporary++}`;
    const result = { smt: `|${name}|`, sort } as const;
    state.declarations.add(`(declare-const |${name}| ${sort})`);
    if (model !== context.currentFunction) {
        for (const ensure of model.ensures) {
            const fact = instantiate(ensure.value, model.parameters, arguments_, result);
            if (fact.sort === "Bool") state.facts.push(fact.smt);
        }
    }
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
    if (ts.isBigIntLiteral(node) || ts.isNumericLiteral(node)) return { smt: node.text.replace(/n$/, ""), sort: "Int" };
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
        return { smt: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false", sort: "Bool" };
    }
    if (ts.isPrefixUnaryExpression(node)) {
        const operand = lowerExpression(node.operand, state, context);
        if (node.operator === ts.SyntaxKind.ExclamationToken && operand.sort === "Bool") return { smt: `(not ${operand.smt})`, sort: "Bool" };
        if (node.operator === ts.SyntaxKind.MinusToken && operand.sort === "Int") return { smt: `(- ${operand.smt})`, sort: "Int" };
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
        if (arithmetic.has(operator) && left.sort === "Int" && right.sort === "Int") {
            if (operator === ts.SyntaxKind.SlashToken || operator === ts.SyntaxKind.PercentToken) {
                addProof(context, state, `(not (= ${right.smt} 0))`, node.right, "division definedness");
            }
            return { smt: `(${arithmetic.get(operator)} ${left.smt} ${right.smt})`, sort: "Int" };
        }
        if (comparison.has(operator) && left.sort === "Int" && right.sort === "Int") return { smt: `(${comparison.get(operator)} ${left.smt} ${right.smt})`, sort: "Bool" };
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
        state.values[node.left.text] = { smt: `(${operator} ${left.smt} ${right.smt})`, sort: left.sort };
    }
    return true;
}

function executeStatement(node: ts.Statement, state: State, context: Context): State[] {
    try {
        if (ts.isBlock(node)) return executeStatements(node.statements, [state], context);
        if (ts.isVariableStatement(node)) {
            for (const declaration of node.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) continue;
                const value = declaration.initializer ? lowerExpression(declaration.initializer, state, context) : undefined;
                const refinement = refinementFromType(declaration.type, context.refinements);
                const sort = sortFromType(declaration.type, context.refinements) ?? value?.sort;
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
            if (ts.isBinaryExpression(node.expression) && updateAssignment(node.expression, state, context)) return [state];
            if (ts.isCallExpression(node.expression)) lowerCall(node.expression, state, context);
            return [state];
        }
        if (ts.isReturnStatement(node) && node.expression) {
            const result = lowerExpression(node.expression, state, context);
            for (const ensure of context.currentFunction?.ensures ?? []) {
                const substitutions = { ...state.values, result };
                const goal = expressionToSmtTerm(ensure.value, { variables: state.variables, substitutions });
                if (goal.sort !== "Bool") throw new Error("A postcondition must be Boolean.");
                addProof(context, state, goal.smt, node.expression, `${context.currentFunction?.name} postcondition`, ensure);
            }
            const refinement = context.currentFunction?.returnRefinement;
            if (refinement) {
                const goal = expressionToSmtTerm(refinement.predicate, { substitutions: { value: result } });
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
        if (ts.isWhileStatement(node)) return executeWhile(node, state, context);
        return [state];
    }
    catch (error) { diagnostic(context, node, error); return [state]; }
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
        const goal = expressionToSmtTerm(invariant.value, { variables: state.variables, substitutions: state.values });
        addProof(context, state, goal.smt, node, "loop invariant initialization", invariant);
    }
    const preserved = cloneState(state);
    preserved.facts.push(condition.smt);
    for (const invariant of invariants) {
        const fact = expressionToSmtTerm(invariant.value, { variables: preserved.variables, substitutions: preserved.values });
        preserved.facts.push(fact.smt);
    }
    const afterBody = executeStatement(node.statement, preserved, context);
    for (const next of afterBody) {
        for (const invariant of invariants) {
            const goal = expressionToSmtTerm(invariant.value, { variables: next.variables, substitutions: next.values });
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
        const fact = expressionToSmtTerm(invariant.value, { variables: exit.variables, substitutions: exit.values });
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

function initialState(model: FunctionModel): State {
    const declarations = new Set<string>();
    for (const [name, sort] of Object.entries(model.variables)) declarations.add(`(declare-const |${name}| ${sort})`);
    const state: State = { variables: { ...model.variables }, values: {}, declarations, facts: [] };
    for (const requirement of model.requires) {
        const fact = expressionToSmtTerm(requirement.value, { variables: state.variables });
        if (fact.sort === "Bool") state.facts.push(fact.smt);
    }
    for (const [name, refinement] of Object.entries(model.parameterRefinements ?? {})) {
        const fact = expressionToSmtTerm(refinement.predicate, {
            substitutions: { value: { smt: `|${name}|`, sort: refinement.sort } },
        });
        if (fact.sort === "Bool") state.facts.push(fact.smt);
    }
    return state;
}

export function collectProgramProofs(source: TSPPAnalysisSourceFile, diagnostics: TSPPAnalysisDiagnostic[]): PendingProof[] {
    const masked = maskContractClauses(source.fileName, source.text, false);
    const sourceFile = ts.createSourceFile(source.fileName, masked, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const functions = parseFunctionModels(source.text);
    const refinements = collectRefinements(source.text);
    for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
        const existing = functions.get(statement.name.text);
        const variables: Record<string, Sort> = {};
        const parameters: string[] = [];
        const parameterRefinements: Record<string, RefinementModel> = {};
        for (const parameter of statement.parameters) {
            if (!ts.isIdentifier(parameter.name)) continue;
            const sort = sortFromType(parameter.type, refinements);
            if (!sort) continue;
            parameters.push(parameter.name.text);
            variables[parameter.name.text] = sort;
            const refinement = refinementFromType(parameter.type, refinements);
            if (refinement) parameterRefinements[parameter.name.text] = refinement;
        }
        functions.set(statement.name.text, {
            name: statement.name.text, parameters, variables,
            requires: existing?.requires ?? [], ensures: existing?.ensures ?? [],
            bodyStart: statement.body?.getStart(sourceFile) ?? statement.end,
            parameterRefinements,
            returnRefinement: refinementFromType(statement.type, refinements),
        });
    }
    const proofs: PendingProof[] = [];
    const base: Omit<Context, "currentFunction"> = {
        fileName: source.fileName, sourceFile, sourceText: source.text, functions, refinements, proofs, diagnostics, nextTemporary: 0,
    };
    for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name || !statement.body) continue;
        const model = functions.get(statement.name.text);
        if (!model) continue;
        const context: Context = { ...base, currentFunction: model };
        executeStatements(statement.body.statements, [initialState(model)], context);
        base.nextTemporary = context.nextTemporary;
    }
    const topLevelState: State = { variables: {}, values: {}, declarations: new Set(), facts: [] };
    for (const statement of sourceFile.statements) {
        if (ts.isVariableStatement(statement) || (ts.isLabeledStatement(statement) && statement.label.text === "assert")) {
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
