import {
  logicDefinitionKey,
  smtApiVersion,
} from "./smtLibrary.js";
import {
  VerificationAxiom,
  VerificationBinding,
  VerificationExpression,
  VerificationFunction,
  VerificationSort,
} from "./verificationIR.js";

/**
 * Reads logic functions defined with `ts-plus-plus/smt` from values a logic
 * module produced at compile time.
 *
 * The value is untrusted input: the module is user code, and the object it
 * exports could have any shape. Reading therefore rebuilds every definition
 * from plain data, accepting only the IR shapes a library may contain and
 * bounding size and depth. The SMT backend sort-checks the result again
 * before anything reaches a solver.
 *
 * @internal
 */
export interface LogicFunctionDefinitions {
  readonly function: VerificationFunction;
  /** The function itself followed by every function it reaches. */
  readonly functions: readonly VerificationFunction[];
}

const maximumDepth = 256;
const maximumNodes = 100_000;

class LogicDefinitionError extends Error {}

/** @internal */
export function readLogicFunction(value: unknown, sourceName: string): LogicFunctionDefinitions | string {
  if (typeof value !== "function" && !isRecord(value)) return `'${sourceName}' is not a logic function from ts-plus-plus/smt.`;
  const definition = (value as Record<string, unknown>)[logicDefinitionKey];
  if (!isRecord(definition)) return `'${sourceName}' is not a logic function from ts-plus-plus/smt.`;
  if (definition.version !== smtApiVersion) {
    return `'${sourceName}' was defined with logic definition format ${String(definition.version)}, but this compiler reads format ${smtApiVersion}.`;
  }
  const budget = { nodes: 0 };
  try {
    const main = readFunction(definition.function, budget);
    if (!Array.isArray(definition.dependencies)) throw new LogicDefinitionError("dependencies must be an array.");
    const dependencies = definition.dependencies.map(dependency => readFunction(dependency, budget));
    const names = new Set<string>([main.name]);
    for (const dependency of dependencies) {
      if (names.has(dependency.name)) throw new LogicDefinitionError(`function '${dependency.name}' is defined twice.`);
      names.add(dependency.name);
    }
    return { function: main, functions: [main, ...dependencies] };
  }
  catch (error) {
    if (error instanceof LogicDefinitionError) return `The definition of '${sourceName}' is malformed: ${error.message}`;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function fail(message: string): never {
  throw new LogicDefinitionError(message);
}

function readString(value: unknown, what: string): string {
  return typeof value === "string" ? value : fail(`${what} must be a string.`);
}

function readFunction(value: unknown, budget: { nodes: number; }): VerificationFunction {
  if (!isRecord(value)) fail("a function definition must be an object.");
  const name = readString(value.name, "a function name");
  if (name.startsWith("tspp.") && !name.startsWith("tspp.js.")) fail(`function '${name}' uses the reserved 'tspp.' prefix.`);
  if (!Array.isArray(value.parameters)) fail(`the parameters of '${name}' must be an array.`);
  const parameters = value.parameters.map(parameter => readBinding(parameter));
  const sort = readSort(value.sort);
  const body = value.body === undefined ? undefined : readExpression(value.body, budget, 0);
  if (value.recursive !== undefined && typeof value.recursive !== "boolean") fail(`'recursive' of '${name}' must be a boolean.`);
  const axioms = value.axioms === undefined ? undefined : Array.isArray(value.axioms) ? value.axioms.map(axiom => readAxiom(axiom, budget)) : fail(`the axioms of '${name}' must be an array.`);
  const origin = readString(value.origin, `the origin of '${name}'`);
  return { name, parameters, sort, body, recursive: value.recursive === true ? true : undefined, axioms, origin };
}

function readAxiom(value: unknown, budget: { nodes: number; }): VerificationAxiom {
  if (!isRecord(value)) fail("an axiom must be an object.");
  return { label: readString(value.label, "an axiom label"), expression: readExpression(value.expression, budget, 0) };
}

function readBinding(value: unknown): VerificationBinding {
  if (!isRecord(value)) fail("a binding must be an object.");
  return { name: readString(value.name, "a binding name"), sort: readSort(value.sort) };
}

/** Libraries use theory sorts and uninterpreted sorts; datatypes come only from program types. */
function readSort(value: unknown): VerificationSort {
  if (value === "Bool" || value === "Int" || value === "Real" || value === "String") return value;
  if (isRecord(value) && value.kind === "uninterpreted") return { kind: "uninterpreted", name: readString(value.name, "a sort name") };
  return fail("a sort must be Bool, Int, Real, String, or an uninterpreted sort.");
}

function readExpression(value: unknown, budget: { nodes: number; }, depth: number): VerificationExpression {
  if (++budget.nodes > maximumNodes) fail(`the definition exceeds ${maximumNodes} term nodes.`);
  if (depth > maximumDepth) fail(`the definition nests deeper than ${maximumDepth} terms.`);
  if (!isRecord(value)) fail("a term must be an object.");
  const next = (item: unknown) => readExpression(item, budget, depth + 1);
  const list = (items: unknown, what: string) => Array.isArray(items) ? items.map(next) : fail(`${what} must be an array.`);
  switch (value.kind) {
    case "variable":
      return { kind: "variable", name: readString(value.name, "a variable name"), sort: readSort(value.sort) };
    case "boolean":
      return typeof value.value === "boolean" ? { kind: "boolean", value: value.value } : fail("a Boolean literal must hold a boolean.");
    case "integer":
      return { kind: "integer", value: readNumeral(value.value, /^-?\d+$/) };
    case "real":
      return { kind: "real", value: readNumeral(value.value, /^-?\d+(?:\.\d+)?$/) };
    case "string":
      return { kind: "string", value: readString(value.value, "a String literal") };
    case "application":
      return { kind: "application", symbol: readString(value.symbol, "an applied symbol"), operands: list(value.operands, "operands") };
    case "quantifier": {
      if (value.quantifier !== "forall" && value.quantifier !== "exists") fail("a quantifier must be forall or exists.");
      if (!Array.isArray(value.bindings)) fail("quantifier bindings must be an array.");
      const patterns = value.patterns === undefined ? undefined : Array.isArray(value.patterns) ? value.patterns.map(pattern => list(pattern, "a pattern")) : fail("patterns must be an array.");
      return { kind: "quantifier", quantifier: value.quantifier, bindings: value.bindings.map(readBinding), body: next(value.body), patterns };
    }
    case "let": {
      if (!Array.isArray(value.bindings)) fail("let bindings must be an array.");
      const bindings = value.bindings.map(binding => {
        if (!isRecord(binding)) fail("a let binding must be an object.");
        return { name: readString(binding.name, "a let name"), value: next(binding.value) };
      });
      return { kind: "let", bindings, body: next(value.body) };
    }
    case "raw":
      if (!Array.isArray(value.symbols)) fail("raw symbols must be an array.");
      return { kind: "raw", text: readString(value.text, "raw SMT-LIB text"), sort: readSort(value.sort), symbols: value.symbols.map(symbol => readString(symbol, "a raw symbol")) };
    default:
      // Free constants and datatype terms describe program state; a library cannot introduce them.
      return fail(`term kind '${String(value.kind)}' is not allowed in a logic library.`);
  }
}

function readNumeral(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : fail(`'${String(value)}' is not a valid numeral.`);
}
