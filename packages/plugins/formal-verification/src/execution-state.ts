import ts from "typescript";
import type { TSPPAnalysisDiagnostic } from "@tspp/plugin-sdk/compiler";
import { expressionToSmtTerm, type Sort, type Term } from "./expression";
import type { PendingProof } from "./contracts";
import type { RefinementModel } from "./refinements";
import type { LogicLibrary } from "./logic";
import type { Clause, DataConstructor, FunctionModel } from "./models";

export interface State {
    readonly variables: Record<string, Sort>;
    readonly values: Record<string, Term>;
    readonly declarations: Set<string>;
    readonly facts: string[];
    /** Why this path can no longer be modeled; obligations reached after it are reported instead of proved. */
    unsupported?: string;
}
export interface JumpTarget {
    readonly kind: "loop" | "switch";
    readonly breaks: State[];
    readonly continues: State[];
}
export interface Context {
    readonly fileName: string;
    readonly sourceFile: ts.SourceFile;
    readonly sourceText: string;
    readonly functions: ReadonlyMap<string, FunctionModel>;
    readonly refinements: ReadonlyMap<string, RefinementModel>;
    readonly records: ReadonlyMap<string, ReadonlyMap<string, Sort>>;
    readonly constructors: ReadonlyMap<string, DataConstructor>;
    readonly logic: LogicLibrary;
    readonly proofs: PendingProof[];
    readonly diagnostics: TSPPAnalysisDiagnostic[];
    readonly currentFunction?: FunctionModel;
    /** Proof-relevant nodes the symbolic executor reached; anything left over is reported as unverified. */
    readonly visited: Set<ts.Node>;
    readonly jumpTargets: JumpTarget[];
    nextTemporary: number;
}

export const cloneState = (state: State): State => ({
    variables: { ...state.variables }, values: { ...state.values },
    declarations: new Set(state.declarations), facts: [...state.facts], unsupported: state.unsupported,
});

export const arithmeticOperators = new Map<number, string>([
    [ts.SyntaxKind.PlusToken, "+"], [ts.SyntaxKind.MinusToken, "-"], [ts.SyntaxKind.AsteriskToken, "*"],
    [ts.SyntaxKind.SlashToken, "tspp.js.trunc.div"], [ts.SyntaxKind.PercentToken, "tspp.js.trunc.rem"],
]);
export const comparisonOperators = new Map<number, string>([
    [ts.SyntaxKind.LessThanToken, "<"], [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanToken, ">"], [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
]);
/** Maps each assignment operator to the arithmetic operator it applies, or undefined for plain `=`. */
export const assignmentOperators = new Map<number, ts.SyntaxKind | undefined>([
    [ts.SyntaxKind.EqualsToken, undefined], [ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.PlusToken],
    [ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.MinusToken], [ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskToken],
    [ts.SyntaxKind.SlashEqualsToken, ts.SyntaxKind.SlashToken], [ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.PercentToken],
]);
export const safeIntegerRange = (smt: string) => `(and (>= ${smt} (- 9007199254740991)) (<= ${smt} 9007199254740991))`;

export function diagnostic(context: Context, node: ts.Node, message: unknown): void {
    context.diagnostics.push({
        fileName: context.fileName, start: node.getStart(context.sourceFile), length: node.getWidth(context.sourceFile),
        code: 19003, category: "error", source: "TS++ verification",
        message: message instanceof Error ? message.message : String(message),
    });
}


export function scriptFor(state: State): string {
    return [...state.declarations, ...state.facts.map(fact => `(assert ${fact})`)].join("\n");
}

export function addProof(context: Context, state: State, goal: string, node: ts.Node, name: string, location?: Clause): void {
    const start = location?.start ?? node.getStart(context.sourceFile);
    const length = location?.value.length ?? node.getWidth(context.sourceFile);
    if (state.unsupported) {
        context.diagnostics.push({
            fileName: context.fileName, start, length, code: 19003, category: "error", source: "TS++ verification",
            message: `${name} cannot be verified because ${state.unsupported}.`,
        });
        return;
    }
    context.proofs.push({ query: { script: scriptFor(state), goal }, fileName: context.fileName, start, length, name });
}

/** Keeps exploring a path the verifier cannot model, but refuses every later proof on it. */
export function unsupported(state: State, node: ts.Node, context: Context): State[] {
    if (!state.unsupported) {
        const line = context.sourceFile.getLineAndCharacterOfPosition(node.getStart(context.sourceFile)).line + 1;
        const text = node.getText(context.sourceFile).split(/\r?\n/)[0].trim();
        state.unsupported = `'${text.length > 40 ? `${text.slice(0, 40)}…` : text}' (line ${line}) is not supported by the verifier`;
    }
    return [state];
}

export function havoc(state: State, name: string, context: Context): void {
    const sort = state.values[name]?.sort ?? state.variables[name];
    if (!sort) return;
    const symbol = `tspp.havoc.${name}.${context.nextTemporary++}`;
    state.declarations.add(`(declare-const |${symbol}| ${sort})`);
    state.values[name] = { smt: `|${symbol}|`, sort };
}

/** The proof-state key an assignment writes, for locals and fields of record parameters. */
export function assignmentKey(node: ts.Expression): string | undefined {
    if (ts.isParenthesizedExpression(node)) return assignmentKey(node.expression);
    if (ts.isIdentifier(node)) return node.text;
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) return `${node.expression.text}.${node.name.text}`;
    return undefined;
}

export function isIncrementOrDecrement(node: ts.Node): node is ts.PrefixUnaryExpression | ts.PostfixUnaryExpression {
    return (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
        && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken);
}

/** Every state key the node may write, ignoring nested functions, which the executor never inlines. */
export function assignedKeys(node: ts.Node): Set<string> {
    const keys = new Set<string>();
    const visit = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        const target = ts.isBinaryExpression(child) && assignmentOperators.has(child.operatorToken.kind) ? child.left
            : isIncrementOrDecrement(child) ? child.operand : undefined;
        const key = target && assignmentKey(target);
        if (key) keys.add(key);
        ts.forEachChild(child, visit);
    };
    visit(node);
    return keys;
}

export function lexicalNames(statements: readonly ts.Statement[]): string[] {
    return statements.flatMap(statement => ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.BlockScoped
        ? statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : [])
        : []);
}

export const isBound = (state: State, name: string) => name in state.values || name in state.variables;

export function innermostLoop(context: Context): JumpTarget | undefined {
    for (let index = context.jumpTargets.length - 1; index >= 0; index--) {
        if (context.jumpTargets[index].kind === "loop") return context.jumpTargets[index];
    }
    return undefined;
}

export function initialState(model: FunctionModel, logic: LogicLibrary): State {
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
