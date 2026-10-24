import {
  VerificationAxiom,
  VerificationBinding,
  VerificationExpression,
  VerificationFunction,
  VerificationSort,
  verificationSortKey,
  verificationSortsEqual,
  VerificationUninterpretedSort,
} from "./verificationIR.js";
import {
  truncatedDivision,
  truncatedRemainder,
} from "./verificationProgramSemantics.js";
import {
  createVerificationLogicFeatures,
  inferTheoryApplicationSort,
  inferVerificationSort,
  isVerificationTheorySymbol,
} from "./verificationSignatures.js";

/*
 * `ts-plus-plus/smt`: typed constructors for SMT-LIB terms and logic
 * definitions that formal contracts can call.
 *
 * Everything here is plain data. Constructors check sorts as soon as a term
 * is built, so a mistake is reported where it is written; the compiler checks
 * every definition again when it reads it, because a logic library is
 * untrusted input. The module has no dependency on the compiler: it is
 * published as a small standalone bundle, and the compiler serves its own
 * copy to logic modules it evaluates, so the IR always matches the compiler.
 */

/** The version of the logic-definition format this module produces. */
export const smtApiVersion = 1;

/** The property under which a logic function carries its definition. */
export const logicDefinitionKey = "tspp.logic.definition";

/** An SMT sort, tagged with the TypeScript type its values correspond to. */
export interface Sort<T> {
  readonly kind: "tspp.smt.sort";
  readonly sort: VerificationSort;
  /** Phantom marker for the TypeScript type; never present at runtime. */
  readonly value?: T;
}

/** An SMT term whose sort corresponds to the TypeScript type `T`. */
export interface Term<T> {
  readonly kind: "tspp.smt.term";
  readonly sort: VerificationSort;
  readonly expression: VerificationExpression;
  /** Logic functions the term applies, including those it reaches through them. */
  readonly functions: readonly VerificationFunction[];
  /** Phantom marker for the TypeScript type; never present at runtime. */
  readonly value?: T;
}

/** A term, or a JavaScript value written as a literal: bigint is Int, number is Real. */
export type TermLike<T> = Term<T> | T;

/** The value type of an uninterpreted sort named `Name`. */
export interface Uninterpreted<Name extends string> {
  readonly uninterpretedSort: Name;
}

/** A parameter of a logic function or quantifier: its SMT name and sort. */
export type Parameter = readonly [name: string, sort: Sort<any>];

/** The terms a body receives for its parameters. */
export type ParameterTerms<P extends readonly Parameter[]> = { [K in keyof P]: P[K] extends readonly [string, Sort<infer T>] ? Term<T> : never; };

/** The TypeScript values a contract passes for the parameters. */
export type ParameterValues<P extends readonly Parameter[]> = { [K in keyof P]: P[K] extends readonly [string, Sort<infer T>] ? T : never; };

/** The serialized definition a logic function carries for the compiler. */
export interface LogicDefinition {
  readonly version: number;
  readonly function: VerificationFunction;
  /** Every other function the definition reaches, in no particular order. */
  readonly dependencies: readonly VerificationFunction[];
}

/**
 * A logic function. Its call signature lets formal contracts call it with
 * program values; it is not executable and throws if JavaScript calls it.
 */
export interface LogicFunction<A extends readonly unknown[], R> {
  (...args: A): R;
  readonly "tspp.logic.definition": LogicDefinition;
}

/** A trusted formula attached to a declared function. */
export interface Axiom {
  readonly kind: "tspp.smt.axiom";
  readonly axiom: VerificationAxiom;
  readonly functions: readonly VerificationFunction[];
}

function sortOf<T>(sort: VerificationSort): Sort<T> {
  return { kind: "tspp.smt.sort", sort };
}

export const Bool: Sort<boolean> = sortOf("Bool");
export const Int: Sort<bigint> = sortOf("Int");
export const Real: Sort<number> = sortOf("Real");
// Named after the SMT-LIB sort; inside this module the global is globalThis.String.
// eslint-disable-next-line local/no-keywords -- `smt.String` mirrors the SMT-LIB sort name, like `smt.Int`.
export const String: Sort<string> = sortOf("String");

/** Declares an uninterpreted sort: values with identity but no structure. */
export function declareSort<const Name extends string>(name: Name): Sort<Uninterpreted<Name>> {
  checkName(name, "sort");
  const sort: VerificationUninterpretedSort = { kind: "uninterpreted", name };
  return sortOf(sort);
}

function isTerm(value: unknown): value is Term<unknown> {
  return !!value && typeof value === "object" && (value as { kind?: unknown; }).kind === "tspp.smt.term";
}

function makeTerm<T>(expression: VerificationExpression, sort: VerificationSort, functions: readonly VerificationFunction[]): Term<T> {
  return { kind: "tspp.smt.term", sort, expression, functions };
}

/** Turns a term or a literal JavaScript value into a term. */
export function term<T>(value: TermLike<T>): Term<T> {
  if (isTerm(value)) return value;
  switch (typeof value) {
    case "boolean":
      return makeTerm({ kind: "boolean", value }, "Bool", []);
    case "bigint":
      return makeTerm({ kind: "integer", value: value.toString() }, "Int", []);
    case "number":
      return real(value) as Term<T>;
    case "string":
      return makeTerm({ kind: "string", value }, "String", []);
    default:
      throw new TypeError(`Cannot use a value of type ${typeof value} as an SMT term.`);
  }
}

export function bool(value: boolean): Term<boolean> {
  return term(value);
}

export function int(value: bigint | number): Term<bigint> {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new RangeError(`${value} is not a safe integer; pass a bigint.`);
  return makeTerm({ kind: "integer", value: BigInt(value).toString() }, "Int", []);
}

/** A Real literal, from a finite number or a decimal string such as "-0.25". */
export function real(value: number | string): Term<number> {
  const text = typeof value === "number" ? numberText(value) : value;
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new RangeError(`'${text}' is not a decimal Real literal.`);
  return makeTerm({ kind: "real", value: text }, "Real", []);
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`${value} has no Real value.`);
  const text = globalThis.String(value);
  if (text.includes("e")) throw new RangeError(`${value} must be written as a decimal string.`);
  return text;
}

export function string(value: string): Term<string> {
  return term(value);
}

function mergeFunctions(groups: readonly (readonly VerificationFunction[])[]): VerificationFunction[] {
  const byName = new Map<string, VerificationFunction>();
  for (const group of groups) {
    for (const definition of group) {
      const existing = byName.get(definition.name);
      if (existing && existing !== definition) throw new Error(`Two different logic functions are named '${definition.name}'.`);
      byName.set(definition.name, definition);
    }
  }
  return [...byName.values()];
}

/** Applies a standard SMT-LIB theory symbol, checking its signature immediately. */
function theory<T>(symbol: string, operands: readonly TermLike<unknown>[]): Term<T> {
  const terms = operands.map(operand => term(operand));
  const expressions = terms.map(item => item.expression);
  const sort = inferTheoryApplicationSort(symbol, terms.map(item => item.sort), expressions);
  return makeTerm({ kind: "application", symbol, operands: expressions }, sort, mergeFunctions(terms.map(item => item.functions)));
}

type Numeric = bigint | number;

// Core
export function not(value: TermLike<boolean>): Term<boolean> {
  return theory("not", [value]);
}
export function and(...values: TermLike<boolean>[]): Term<boolean> {
  return theory("and", values);
}
export function or(...values: TermLike<boolean>[]): Term<boolean> {
  return theory("or", values);
}
export function implies(premise: TermLike<boolean>, conclusion: TermLike<boolean>): Term<boolean> {
  return theory("=>", [premise, conclusion]);
}
export function xor(left: TermLike<boolean>, right: TermLike<boolean>): Term<boolean> {
  return theory("xor", [left, right]);
}
export function eq<T>(left: TermLike<T>, right: TermLike<T>): Term<boolean> {
  return theory("=", [left, right]);
}
export function distinct<T>(...values: TermLike<T>[]): Term<boolean> {
  return theory("distinct", values);
}
export function ite<T>(condition: TermLike<boolean>, then: TermLike<T>, otherwise: TermLike<T>): Term<T> {
  return theory("ite", [condition, then, otherwise]);
}

// Ints and Reals
export function add<T extends Numeric>(...values: TermLike<T>[]): Term<T> {
  return theory("+", values);
}
export function sub<T extends Numeric>(...values: TermLike<T>[]): Term<T> {
  return theory("-", values);
}
export function neg<T extends Numeric>(value: TermLike<T>): Term<T> {
  return theory("-", [value]);
}
export function mul<T extends Numeric>(...values: TermLike<T>[]): Term<T> {
  return theory("*", values);
}
/** SMT-LIB Euclidean integer division; see `js.div` for JavaScript's truncating `/`. */
export function div(dividend: TermLike<bigint>, divisor: TermLike<bigint>): Term<bigint> {
  return theory("div", [dividend, divisor]);
}
/** SMT-LIB Euclidean remainder, always non-negative; see `js.rem` for JavaScript's `%`. */
export function mod(dividend: TermLike<bigint>, divisor: TermLike<bigint>): Term<bigint> {
  return theory("mod", [dividend, divisor]);
}
export function abs(value: TermLike<bigint>): Term<bigint> {
  return theory("abs", [value]);
}
/** Real division. */
export function divide(dividend: TermLike<number>, divisor: TermLike<number>): Term<number> {
  return theory("/", [dividend, divisor]);
}
export function lt<T extends Numeric>(left: TermLike<T>, right: TermLike<T>): Term<boolean> {
  return theory("<", [left, right]);
}
export function le<T extends Numeric>(left: TermLike<T>, right: TermLike<T>): Term<boolean> {
  return theory("<=", [left, right]);
}
export function gt<T extends Numeric>(left: TermLike<T>, right: TermLike<T>): Term<boolean> {
  return theory(">", [left, right]);
}
export function ge<T extends Numeric>(left: TermLike<T>, right: TermLike<T>): Term<boolean> {
  return theory(">=", [left, right]);
}
export function toReal(value: TermLike<bigint>): Term<number> {
  return theory("to_real", [value]);
}
export function toInt(value: TermLike<number>): Term<bigint> {
  return theory("to_int", [value]);
}
export function isInt(value: TermLike<number>): Term<boolean> {
  return theory("is_int", [value]);
}

// Strings
export function concat(...values: TermLike<string>[]): Term<string> {
  return theory("str.++", values);
}
export function length(value: TermLike<string>): Term<bigint> {
  return theory("str.len", [value]);
}
export function contains(value: TermLike<string>, part: TermLike<string>): Term<boolean> {
  return theory("str.contains", [value, part]);
}
export function prefixOf(prefix: TermLike<string>, value: TermLike<string>): Term<boolean> {
  return theory("str.prefixof", [prefix, value]);
}
export function suffixOf(suffix: TermLike<string>, value: TermLike<string>): Term<boolean> {
  return theory("str.suffixof", [suffix, value]);
}
export function charAt(value: TermLike<string>, index: TermLike<bigint>): Term<string> {
  return theory("str.at", [value, index]);
}
export function substring(value: TermLike<string>, start: TermLike<bigint>, count: TermLike<bigint>): Term<string> {
  return theory("str.substr", [value, start, count]);
}

function applyDefinition<T>(definition: VerificationFunction, dependencies: readonly VerificationFunction[], args: readonly TermLike<unknown>[]): Term<T> {
  const terms = args.map(arg => term(arg));
  if (terms.length !== definition.parameters.length || terms.some((item, index) => !verificationSortsEqual(item.sort, definition.parameters[index].sort))) {
    throw new TypeError(`'${definition.name}' expects (${definition.parameters.map(parameter => sortName(parameter.sort)).join(" ")}), got (${terms.map(item => sortName(item.sort)).join(" ")}).`);
  }
  return makeTerm(
    { kind: "application", symbol: definition.name, operands: terms.map(item => item.expression) },
    definition.sort,
    mergeFunctions([[definition], dependencies, ...terms.map(item => item.functions)]),
  );
}

/** JavaScript program semantics, for stating facts about what program code computes. */
export const js: {
  /** JavaScript bigint `/`: truncates toward zero. Unspecified for a zero divisor. */
  readonly div: (dividend: TermLike<bigint>, divisor: TermLike<bigint>) => Term<bigint>;
  /** JavaScript bigint `%`: takes the sign of the dividend. Unspecified for a zero divisor. */
  readonly rem: (dividend: TermLike<bigint>, divisor: TermLike<bigint>) => Term<bigint>;
} = {
  div: (dividend, divisor) => applyDefinition(truncatedDivision, [], [dividend, divisor]),
  rem: (dividend, divisor) => applyDefinition(truncatedRemainder, [], [dividend, divisor]),
};

/** Applies a logic function to terms. */
export function apply<A extends readonly unknown[], R>(fn: LogicFunction<A, R>, ...args: { [K in keyof A]: TermLike<A[K]>; }): Term<R> {
  const definition = fn[logicDefinitionKey];
  return applyDefinition(definition.function, definition.dependencies, args);
}

function bind<P extends readonly Parameter[]>(parameters: P): { readonly bindings: VerificationBinding[]; readonly terms: ParameterTerms<P>; } {
  const bindings: VerificationBinding[] = [];
  const names = new Set<string>();
  for (const [name, sort] of parameters) {
    checkName(name, "parameter");
    if (names.has(name)) throw new Error(`Parameter '${name}' is declared twice.`);
    names.add(name);
    bindings.push({ name, sort: sort.sort });
  }
  const terms = bindings.map(binding => makeTerm({ kind: "variable", name: binding.name, sort: binding.sort }, binding.sort, []));
  return { bindings, terms: terms as unknown as ParameterTerms<P> };
}

/** Universal quantification. `patterns` selects instantiation triggers (`:pattern`). */
export function forall<const P extends readonly Parameter[]>(
  parameters: P,
  body: (...variables: ParameterTerms<P>) => TermLike<boolean>,
  options?: { readonly patterns?: (...variables: ParameterTerms<P>) => readonly (readonly TermLike<unknown>[])[]; },
): Term<boolean> {
  return quantifier("forall", parameters, body, options);
}

/** Existential quantification. */
export function exists<const P extends readonly Parameter[]>(
  parameters: P,
  body: (...variables: ParameterTerms<P>) => TermLike<boolean>,
  options?: { readonly patterns?: (...variables: ParameterTerms<P>) => readonly (readonly TermLike<unknown>[])[]; },
): Term<boolean> {
  return quantifier("exists", parameters, body, options);
}

function quantifier<P extends readonly Parameter[]>(
  quantifier: "forall" | "exists",
  parameters: P,
  body: (...variables: ParameterTerms<P>) => TermLike<boolean>,
  options: { readonly patterns?: (...variables: ParameterTerms<P>) => readonly (readonly TermLike<unknown>[])[]; } | undefined,
): Term<boolean> {
  if (!parameters.length) throw new Error(`A ${quantifier} quantifier must bind at least one variable.`);
  const { bindings, terms } = bind(parameters);
  const result = term(body(...terms));
  if (result.sort !== "Bool") throw new TypeError(`A ${quantifier} body must have sort Bool, got ${sortName(result.sort)}.`);
  const patterns = options?.patterns?.(...terms).map(pattern => pattern.map(item => term(item)));
  return makeTerm(
    { kind: "quantifier", quantifier, bindings, body: result.expression, patterns: patterns?.map(pattern => pattern.map(item => item.expression)) },
    "Bool",
    mergeFunctions([result.functions, ...(patterns ?? []).flat().map(item => item.functions)]),
  );
}

/**
 * Raw SMT-LIB with no structured constructor. The text is printed verbatim;
 * `symbols` must list every logic function it applies, so their definitions
 * are emitted too. Raw text makes the problem's logic `ALL`.
 */
export function raw<T>(text: string, sort: Sort<T>, functions: readonly LogicFunction<any, any>[] = []): Term<T> {
  const definitions = functions.map(fn => fn[logicDefinitionKey]);
  return makeTerm(
    { kind: "raw", text, sort: sort.sort, symbols: definitions.map(definition => definition.function.name) },
    sort.sort,
    mergeFunctions(definitions.map(definition => [definition.function, ...definition.dependencies])),
  );
}

/** A trusted formula, attached to a function with `declareFunction(..., { axioms })`. */
export function axiom(label: string, formula: TermLike<boolean>): Axiom {
  const result = term(formula);
  if (result.sort !== "Bool") throw new TypeError(`Axiom '${label}' must have sort Bool, got ${sortName(result.sort)}.`);
  return { kind: "tspp.smt.axiom", axiom: { label, expression: result.expression }, functions: result.functions };
}

/** A non-recursive predicate: a `define-fun` returning Bool. */
export function definePredicate<const P extends readonly Parameter[]>(
  name: string,
  parameters: P,
  body: (...args: ParameterTerms<P>) => TermLike<boolean>,
): LogicFunction<ParameterValues<P>, boolean> {
  return defineFunction(name, parameters, Bool, body);
}

/** A non-recursive function: a `define-fun`, a conservative extension that adds no trusted input. */
export function defineFunction<const P extends readonly Parameter[], R>(
  name: string,
  parameters: P,
  result: Sort<R>,
  body: (...args: ParameterTerms<P>) => TermLike<R>,
): LogicFunction<ParameterValues<P>, R> {
  checkName(name, "function");
  const { bindings, terms } = bind(parameters);
  const value = term(body(...terms));
  const definition: VerificationFunction = { name, parameters: bindings, sort: result.sort, body: value.expression, origin: `logic function ${name} (ts-plus-plus/smt)` };
  return createLogicFunction(definition, value.functions);
}

/**
 * A recursive function: a `define-fun-rec`. Nothing checks that it
 * terminates, so it is a trusted input and every proof that reaches it
 * reports it. The body receives the function itself first.
 */
export function defineRecursiveFunction<const P extends readonly Parameter[], R>(
  name: string,
  parameters: P,
  result: Sort<R>,
  body: (self: LogicFunction<ParameterValues<P>, R>, ...args: ParameterTerms<P>) => TermLike<R>,
): LogicFunction<ParameterValues<P>, R> {
  checkName(name, "function");
  const { bindings, terms } = bind(parameters);
  const header: VerificationFunction = { name, parameters: bindings, sort: result.sort, origin: `recursive logic function ${name} (ts-plus-plus/smt)` };
  const self = createLogicFunction<ParameterValues<P>, R>(header, [], /*validate*/ false);
  const value = term(body(self, ...terms));
  const definition: VerificationFunction = { ...header, body: value.expression, recursive: true };
  return createLogicFunction(definition, value.functions.filter(dependency => dependency !== header));
}

/**
 * An uninterpreted function (`declare-fun`). Its meaning comes only from its
 * axioms, which are trusted inputs. `axioms` receives the function so that
 * they can mention it.
 */
export function declareFunction<const P extends readonly Parameter[], R>(
  name: string,
  parameters: P,
  result: Sort<R>,
  options?: { readonly axioms?: (self: LogicFunction<ParameterValues<P>, R>) => readonly Axiom[]; },
): LogicFunction<ParameterValues<P>, R> {
  checkName(name, "function");
  const { bindings } = bind(parameters);
  const header: VerificationFunction = { name, parameters: bindings, sort: result.sort, origin: `declared logic function ${name} (ts-plus-plus/smt)` };
  if (!options?.axioms) return createLogicFunction(header, []);
  const self = createLogicFunction<ParameterValues<P>, R>(header, [], /*validate*/ false);
  const axioms = options.axioms(self);
  const definition: VerificationFunction = { ...header, axioms: axioms.map(item => item.axiom) };
  return createLogicFunction(definition, mergeFunctions(axioms.map(item => item.functions)).filter(dependency => dependency !== header));
}

function createLogicFunction<A extends readonly unknown[], R>(
  definition: VerificationFunction,
  dependencies: readonly VerificationFunction[],
  validate = true,
): LogicFunction<A, R> {
  const others = dependencies.filter(dependency => dependency.name !== definition.name);
  if (validate) validateDefinition(definition, others);
  const logicDefinition: LogicDefinition = { version: smtApiVersion, function: definition, dependencies: others };
  const fn = (): never => {
    throw new Error(`Logic function '${definition.name}' can only be used in formal verification specifications; it is not executable.`);
  };
  Object.defineProperty(fn, "name", { value: definition.name });
  Object.defineProperty(fn, logicDefinitionKey, { value: logicDefinition, enumerable: false });
  return fn as unknown as LogicFunction<A, R>;
}

/** Sort-checks a finished definition with its parameters bound, as the compiler will. */
function validateDefinition(definition: VerificationFunction, dependencies: readonly VerificationFunction[]): void {
  const functions = new Map(dependencies.map(dependency => [dependency.name, dependency]));
  functions.set(definition.name, definition);
  const scope = { constants: new Map(), functions, features: createVerificationLogicFeatures(), referencedFunctions: new Set<string>(), sorts: new Set<VerificationSort>() };
  if (definition.body) {
    const bound = new Map(definition.parameters.map(parameter => [parameter.name, parameter.sort]));
    const sort = inferVerificationSort(definition.body, scope, bound);
    if (!verificationSortsEqual(sort, definition.sort)) throw new TypeError(`The body of '${definition.name}' has sort ${sortName(sort)}, expected ${sortName(definition.sort)}.`);
    if (!definition.recursive && scope.referencedFunctions.has(definition.name)) throw new Error(`'${definition.name}' refers to itself; use defineRecursiveFunction.`);
  }
  for (const item of definition.axioms ?? []) {
    if (inferVerificationSort(item.expression, scope) !== "Bool") throw new TypeError(`Axiom '${item.label}' must have sort Bool.`);
  }
}

const symbolPattern = /^[a-z_][\w.$-]*$/i;

function checkName(name: string, what: string): void {
  if (!symbolPattern.test(name)) throw new Error(`'${name}' is not a valid ${what} name: use letters, digits, '_', '.', '$' or '-', starting with a letter or '_'.`);
  if (name.startsWith("tspp.")) throw new Error(`'${name}' uses the reserved 'tspp.' prefix.`);
  if (isVerificationTheorySymbol(name)) throw new Error(`'${name}' would shadow a standard SMT-LIB theory symbol.`);
}

function sortName(sort: VerificationSort): string {
  return typeof sort === "string" ? sort : sort.kind === "uninterpreted" ? sort.name : verificationSortKey(sort);
}
