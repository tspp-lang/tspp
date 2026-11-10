import type * as TS from "typescript-upstream";
import { nameText, nodeStart, ts } from "./host-api";
import { isNumericSort, smtSort, strictEquality, stringTerm, type Sort, type Term } from "./expression";

export interface LogicSignature {
    readonly parameters: readonly Sort[];
    readonly result: Sort;
}

export interface LogicLibrary {
    readonly declarations: readonly string[];
    readonly functions: Readonly<Record<string, LogicSignature>>;
}

interface LoweringContext {
    readonly sourceFile: TS.SourceFile;
    readonly variables: ReadonlyMap<string, Sort>;
    readonly functions: ReadonlyMap<string, LogicSignature>;
}

const emptyLibrary: LogicLibrary = { declarations: [], functions: {} };

function callName(expression: TS.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return nameText(expression);
    if (ts.isPropertyAccessExpression(expression)) return nameText(expression.name);
    return undefined;
}

function sortFromNode(node: TS.Expression | undefined): Sort | undefined {
    const name = node && (ts.isIdentifier(node) ? nameText(node) : ts.isPropertyAccessExpression(node) ? nameText(node.name) : undefined);
    return name === "Bool" || name === "Int" || name === "Real" || name === "String" ? name : undefined;
}

function parametersFromNode(node: TS.Expression | undefined): readonly { name: string; sort: Sort; }[] {
    if (!node || !ts.isArrayLiteralExpression(node)) throw new Error("SMT parameters must be an array of [name, sort] pairs.");
    return node.elements.map(element => {
        if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2 || !ts.isStringLiteral(element.elements[0])) {
            throw new Error("Each SMT parameter must be [name, sort].");
        }
        const sort = sortFromNode(element.elements[1] as TS.Expression);
        if (!sort) throw new Error("Unknown SMT sort.");
        return { name: nameText(element.elements[0]), sort };
    });
}

function functionSorts(node: TS.Expression | undefined): readonly Sort[] {
    if (!node || !ts.isArrayLiteralExpression(node)) throw new Error("Declared function parameters must be a sort array.");
    return node.elements.map(element => {
        const sort = sortFromNode(element as TS.Expression);
        if (!sort) throw new Error("Unknown SMT sort.");
        return sort;
    });
}

function sameSort(left: Term, right: Term): void {
    if (left.sort !== right.sort) throw new Error(`SMT operands have different sorts: ${left.sort} and ${right.sort}.`);
}

function lower(node: TS.Expression, context: LoweringContext): Term {
    if (ts.isParenthesizedExpression(node)) return lower(node.expression, context);
    if (ts.isIdentifier(node)) {
        if (nameText(node) === "true" || nameText(node) === "false") return { smt: nameText(node), sort: "Bool" };
        const sort = context.variables.get(nameText(node));
        if (!sort) throw new Error(`Unknown SMT variable '${nameText(node)}'.`);
        return { smt: `|${nameText(node)}|`, sort };
    }
    if (ts.isBigIntLiteral(node)) return { smt: nameText(node).replace(/n$/, ""), sort: "Int" };
    if (ts.isNumericLiteral(node)) return { smt: nameText(node), sort: nameText(node).includes(".") ? "Real" : "NumberInt" };
    if (ts.isStringLiteral(node)) return stringTerm(nameText(node));
    if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
        return { smt: node.kind === ts.SyntaxKind.TrueKeyword ? "true" : "false", sort: "Bool" };
    }
    if (ts.isPrefixUnaryExpression(node)) {
        const value = lower(node.operand, context);
        if (node.operator === ts.SyntaxKind.ExclamationToken && value.sort === "Bool") return { smt: `(not ${value.smt})`, sort: "Bool" };
        if (node.operator === ts.SyntaxKind.MinusToken && isNumericSort(value.sort)) return { smt: `(- ${value.smt})`, sort: value.sort };
        throw new Error("Unsupported SMT unary expression.");
    }
    if (ts.isConditionalExpression(node)) {
        const condition = lower(node.condition, context);
        const whenTrue = lower(node.whenTrue, context);
        const whenFalse = lower(node.whenFalse, context);
        if (condition.sort !== "Bool") throw new Error("SMT condition must be Boolean.");
        sameSort(whenTrue, whenFalse);
        return { smt: `(ite ${condition.smt} ${whenTrue.smt} ${whenFalse.smt})`, sort: whenTrue.sort };
    }
    if (ts.isBinaryExpression(node)) return lowerBinary(node, context);
    if (ts.isCallExpression(node)) return lowerCall(node, context);
    throw new Error(`Unsupported SMT expression '${context.sourceFile.text.slice(nodeStart(node, context.sourceFile), node.end)}'.`);
}

function lowerBinary(node: TS.BinaryExpression, context: LoweringContext): Term {
    const left = lower(node.left, context);
    const right = lower(node.right, context);
    const kind = node.operatorToken.kind;
    if (kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken) {
        const equal = strictEquality(left, right);
        return { smt: kind === ts.SyntaxKind.EqualsEqualsEqualsToken ? equal : `(not ${equal})`, sort: "Bool" };
    }
    const arithmetic = new Map<number, string>([
        [ts.SyntaxKind.PlusToken, "+"], [ts.SyntaxKind.MinusToken, "-"], [ts.SyntaxKind.AsteriskToken, "*"],
        [ts.SyntaxKind.SlashToken, left.sort === "Real" ? "/" : "tspp.js.trunc.div"],
        [ts.SyntaxKind.PercentToken, "tspp.js.trunc.rem"],
    ]);
    const comparison = new Map<number, string>([
        [ts.SyntaxKind.LessThanToken, "<"], [ts.SyntaxKind.LessThanEqualsToken, "<="],
        [ts.SyntaxKind.GreaterThanToken, ">"], [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
    ]);
    if (comparison.has(kind) && isNumericSort(left.sort) && isNumericSort(right.sort)) {
        return { smt: `(${comparison.get(kind)} ${left.smt} ${right.smt})`, sort: "Bool" };
    }
    sameSort(left, right);
    if (arithmetic.has(kind) && isNumericSort(left.sort)) {
        return { smt: `(${arithmetic.get(kind)} ${left.smt} ${right.smt})`, sort: left.sort };
    }
    if (kind === ts.SyntaxKind.EqualsEqualsToken) return { smt: `(= ${left.smt} ${right.smt})`, sort: "Bool" };
    if (kind === ts.SyntaxKind.ExclamationEqualsToken) return { smt: `(not (= ${left.smt} ${right.smt}))`, sort: "Bool" };
    if (kind === ts.SyntaxKind.AmpersandAmpersandToken && left.sort === "Bool") return { smt: `(and ${left.smt} ${right.smt})`, sort: "Bool" };
    if (kind === ts.SyntaxKind.BarBarToken && left.sort === "Bool") return { smt: `(or ${left.smt} ${right.smt})`, sort: "Bool" };
    throw new Error("Unsupported SMT binary expression.");
}

function lowerCall(node: TS.CallExpression, context: LoweringContext): Term {
    const name = callName(node.expression);
    if (!name) throw new Error("Unsupported SMT call target.");
    if (name === "forall" || name === "exists") return lowerQuantifier(name, node, context);
    const helper = new Map<string, { symbol: string; result?: Sort; }>([
        ["and", { symbol: "and", result: "Bool" }], ["or", { symbol: "or", result: "Bool" }],
        ["not", { symbol: "not", result: "Bool" }], ["implies", { symbol: "=>", result: "Bool" }],
        ["eq", { symbol: "=", result: "Bool" }], ["lt", { symbol: "<", result: "Bool" }],
        ["le", { symbol: "<=", result: "Bool" }], ["gt", { symbol: ">", result: "Bool" }],
        ["ge", { symbol: ">=", result: "Bool" }], ["add", { symbol: "+" }],
        ["sub", { symbol: "-" }], ["mul", { symbol: "*" }], ["div", { symbol: "tspp.js.trunc.div", result: "Int" }],
        ["rem", { symbol: "tspp.js.trunc.rem", result: "Int" }],
    ]);
    if (name === "ite") {
        const values = node.arguments.map(argument => lower(argument, context));
        if (values.length !== 3 || values[0].sort !== "Bool") throw new Error("ite expects a condition and two values.");
        sameSort(values[1], values[2]);
        return { smt: `(ite ${values.map(value => value.smt).join(" ")})`, sort: values[1].sort };
    }
    const directName = name === "apply" && node.arguments.length ? callName(node.arguments[0]) : name;
    const arguments_ = (name === "apply" ? node.arguments.slice(1) : node.arguments).map(argument => lower(argument, context));
    const known = directName && context.functions.get(directName);
    if (known) {
        if (known.parameters.length !== arguments_.length) throw new Error(`SMT function '${directName}' has the wrong arity.`);
        known.parameters.forEach((sort, index) => {
            if (smtSort(sort) !== smtSort(arguments_[index].sort)) throw new Error(`SMT argument ${index + 1} has the wrong sort.`);
        });
        return { smt: `(|${directName}|${arguments_.length ? ` ${arguments_.map(value => value.smt).join(" ")}` : ""})`, sort: known.result };
    }
    const operation = helper.get(name);
    if (!operation || !arguments_.length) throw new Error(`Unknown SMT function '${name}'.`);
    if (!operation.result) arguments_.slice(1).forEach(value => sameSort(arguments_[0], value));
    return { smt: `(${operation.symbol} ${arguments_.map(value => value.smt).join(" ")})`, sort: operation.result ?? arguments_[0].sort };
}

function lowerQuantifier(name: "forall" | "exists", node: TS.CallExpression, context: LoweringContext): Term {
    const parameters = parametersFromNode(node.arguments[0]);
    const body = node.arguments[1];
    if (!body || !ts.isArrowFunction(body) || !ts.isExpression(body.body)) throw new Error(`${name} requires an expression arrow function.`);
    const variables = new Map(context.variables);
    parameters.forEach((parameter, index) => variables.set((body.parameters[index] ? context.sourceFile.text.slice(nodeStart(body.parameters[index].name, context.sourceFile), body.parameters[index].name.end) : parameter.name), parameter.sort));
    const result = lower(body.body, { ...context, variables });
    if (result.sort !== "Bool") throw new Error(`${name} body must be Boolean.`);
    return { smt: `(${name} (${parameters.map(parameter => `(|${parameter.name}| ${parameter.sort})`).join(" ")}) ${result.smt})`, sort: "Bool" };
}

function arrowBody(node: TS.Expression | undefined): TS.Expression {
    if (!node || !ts.isArrowFunction(node) || !ts.isExpression(node.body)) throw new Error("SMT definitions require an expression arrow function.");
    return node.body;
}

/** Logic definitions are plain TypeScript at the top level of a file, wherever the file's other syntax comes from. */
export function collectLogicLibrary(sourceTexts: readonly string[]): LogicLibrary {
    if (!sourceTexts.length) return emptyLibrary;
    const declarations: string[] = [];
    const functions = new Map<string, LogicSignature>();
    const pending: { name: string; kind: string; call: TS.CallExpression; sourceFile: TS.SourceFile; }[] = [];
    const axioms: { call: TS.CallExpression; sourceFile: TS.SourceFile; }[] = [];
    sourceTexts.forEach((text, index) => {
        const sourceFile = ts.createSourceFile(`logic-${index}.ts`, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        for (const statement of sourceFile.statements) {
            if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
                const kind = callName(declaration.initializer.expression);
                if (!kind || !["definePredicate", "defineFunction", "defineRecursiveFunction", "declareFunction"].includes(kind)) continue;
                const call = declaration.initializer;
                const parameterSorts = kind === "declareFunction" ? functionSorts(call.arguments[0]) : parametersFromNode(call.arguments[0]).map(item => item.sort);
                const result = kind === "definePredicate" ? "Bool" : sortFromNode(call.arguments[1] as TS.Expression);
                if (!result) throw new Error(`SMT function '${nameText(declaration.name)}' has no valid result sort.`);
                functions.set(nameText(declaration.name), { parameters: parameterSorts, result });
                pending.push({ name: nameText(declaration.name), kind, call, sourceFile });
            }
            if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression) && callName(statement.expression.expression) === "axiom") {
                axioms.push({ call: statement.expression, sourceFile });
            }
        }
    });
    for (const item of pending) {
        const signature = functions.get(item.name)!;
        if (item.kind === "declareFunction") {
            declarations.push(`(declare-fun |${item.name}| (${signature.parameters.join(" ")}) ${signature.result})`);
            continue;
        }
        const parameters = parametersFromNode(item.call.arguments[0]);
        const bodyNode = arrowBody(item.call.arguments[item.kind === "definePredicate" ? 1 : 2]);
        const variables = new Map(parameters.map(parameter => [parameter.name, parameter.sort] as const));
        const term = lower(bodyNode, { sourceFile: item.sourceFile, variables, functions });
        if (smtSort(term.sort) !== smtSort(signature.result)) throw new Error(`SMT function '${item.name}' body has the wrong sort.`);
        const command = item.kind === "defineRecursiveFunction" ? "define-fun-rec" : "define-fun";
        declarations.push(`(${command} |${item.name}| (${parameters.map(parameter => `(|${parameter.name}| ${parameter.sort})`).join(" ")}) ${signature.result} ${term.smt})`);
    }
    for (const item of axioms) {
        const parameters = parametersFromNode(item.call.arguments[0]);
        const body = arrowBody(item.call.arguments[1]);
        const variables = new Map(parameters.map(parameter => [parameter.name, parameter.sort] as const));
        const term = lower(body, { sourceFile: item.sourceFile, variables, functions });
        if (term.sort !== "Bool") throw new Error("An SMT axiom must be Boolean.");
        const quantified = parameters.length ? `(forall (${parameters.map(parameter => `(|${parameter.name}| ${parameter.sort})`).join(" ")}) ${term.smt})` : term.smt;
        declarations.push(`; trusted axiom\n(assert ${quantified})`);
    }
    return { declarations, functions: Object.fromEntries(functions) };
}
