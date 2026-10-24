import { hasProperty } from "./core.js";
import {
  isVerificationNumericSort,
  isVerificationStructuredSort,
  VerificationExpression,
  VerificationFunction,
  VerificationSort,
  verificationSortKey,
  verificationSortsEqual,
} from "./verificationIR.js";

/*
 * Standard SMT-LIB 2.6 theory signatures and the sort checker for the
 * verification IR. Every application symbol is resolved here or against a
 * function the problem declares; nothing outside the standard theories is
 * accepted, so the printed SMT-LIB never depends on one particular solver.
 */

/** Theory and logic features a problem uses; they decide its `set-logic`. */
export interface VerificationLogicFeatures {
  ints: boolean;
  reals: boolean;
  nonlinear: boolean;
  strings: boolean;
  datatypes: boolean;
  uninterpretedFunctions: boolean;
  quantifiers: boolean;
  raw: boolean;
}

export function createVerificationLogicFeatures(): VerificationLogicFeatures {
  return { ints: false, reals: false, nonlinear: false, strings: false, datatypes: false, uninterpretedFunctions: false, quantifiers: false, raw: false };
}

interface SignatureError {
  readonly error: string;
}

type SignatureResult = VerificationSort | SignatureError;
type Signature = (operands: readonly VerificationSort[], features: VerificationLogicFeatures, expressions: readonly VerificationExpression[]) => SignatureResult;

function allSorts(operands: readonly VerificationSort[], sort: VerificationSort): boolean {
  return operands.every(operand => verificationSortsEqual(operand, sort));
}

function boolean(minimum: number, maximum = Infinity): Signature {
  return operands => operands.length < minimum || operands.length > maximum ? arityError(minimum, maximum) : allSorts(operands, "Bool") ? "Bool" : fail("expects Bool operands");
}

function fail(error: string): SignatureError {
  return { error };
}

function arityError(minimum: number, maximum: number): SignatureError {
  return fail(maximum === Infinity ? `expects at least ${minimum} operand(s)` : minimum === maximum ? `expects ${minimum} operand(s)` : `expects ${minimum}-${maximum} operands`);
}

function recordNumeric(sort: "Int" | "Real", features: VerificationLogicFeatures): void {
  if (sort === "Int") features.ints = true;
  else features.reals = true;
}

function isNumericLiteral(expression: VerificationExpression): boolean {
  if (expression.kind === "integer" || expression.kind === "real") return true;
  return expression.kind === "application" && expression.symbol === "-" && expression.operands.length === 1 && isNumericLiteral(expression.operands[0]);
}

/**
 * Polymorphic Ints/Reals arithmetic. Mixed Int/Real operands are rejected:
 * Reals_Ints conversions must be explicit (`to_real`, `to_int`).
 */
function arithmetic(minimum: number, result: "operand" | "Bool", options: { readonly only?: "Int" | "Real"; readonly nonlinear?: "product" | "divisor"; } = {}): Signature {
  return (operands, features, expressions) => {
    if (operands.length < minimum) return arityError(minimum, Infinity);
    const sort = operands[0];
    if (!isVerificationNumericSort(sort) || !allSorts(operands, sort)) return fail("expects operands of one numeric sort");
    if (options.only && sort !== options.only) return fail(`expects ${options.only} operands`);
    recordNumeric(sort, features);
    if (options.nonlinear === "product" && expressions.filter(expression => !isNumericLiteral(expression)).length > 1) features.nonlinear = true;
    if (options.nonlinear === "divisor" && expressions.slice(1).some(expression => !isNumericLiteral(expression))) features.nonlinear = true;
    return result === "Bool" ? "Bool" : sort;
  };
}

function fixed(parameters: readonly VerificationSort[], result: VerificationSort, record: (features: VerificationLogicFeatures) => void): Signature {
  return (operands, features) => {
    if (operands.length !== parameters.length) return arityError(parameters.length, parameters.length);
    if (operands.some((operand, index) => !verificationSortsEqual(operand, parameters[index]))) return fail(`expects (${parameters.join(" ")})`);
    record(features);
    return result;
  };
}

const recordStrings = (features: VerificationLogicFeatures) => features.strings = true;
const recordStringsAndInts = (features: VerificationLogicFeatures) => {
  features.strings = true;
  features.ints = true;
};
const recordIntsAndReals = (features: VerificationLogicFeatures) => {
  features.ints = true;
  features.reals = true;
};

const theorySignatures = new Map<string, Signature>([
  // Core
  ["not", boolean(1, 1)],
  ["and", boolean(0)],
  ["or", boolean(0)],
  ["xor", boolean(2)],
  ["=>", boolean(2)],
  ["=", operands => operands.length < 2 ? arityError(2, Infinity) : allSorts(operands, operands[0]) ? "Bool" : fail("expects operands of one sort")],
  ["distinct", operands => operands.length < 2 ? arityError(2, Infinity) : allSorts(operands, operands[0]) ? "Bool" : fail("expects operands of one sort")],
  ["ite", operands => operands.length !== 3 ? arityError(3, 3) : operands[0] !== "Bool" ? fail("expects a Bool condition") : verificationSortsEqual(operands[1], operands[2]) ? operands[1] : fail("expects branches of one sort")],
  // Ints and Reals
  ["+", arithmetic(2, "operand")],
  ["-", arithmetic(1, "operand")],
  ["*", arithmetic(2, "operand", { nonlinear: "product" })],
  ["/", arithmetic(2, "operand", { only: "Real", nonlinear: "divisor" })],
  ["div", arithmetic(2, "operand", { only: "Int", nonlinear: "divisor" })],
  ["mod", arithmetic(2, "operand", { only: "Int", nonlinear: "divisor" })],
  ["abs", arithmetic(1, "operand", { only: "Int" })],
  ["<", arithmetic(2, "Bool")],
  ["<=", arithmetic(2, "Bool")],
  [">", arithmetic(2, "Bool")],
  [">=", arithmetic(2, "Bool")],
  // Reals_Ints
  ["to_real", fixed(["Int"], "Real", recordIntsAndReals)],
  ["to_int", fixed(["Real"], "Int", recordIntsAndReals)],
  ["is_int", fixed(["Real"], "Bool", recordIntsAndReals)],
  // Strings
  ["str.++", (operands, features) => {
    if (operands.length < 2) return arityError(2, Infinity);
    if (!allSorts(operands, "String")) return fail("expects String operands");
    recordStrings(features);
    return "String";
  }],
  ["str.len", fixed(["String"], "Int", recordStringsAndInts)],
  ["str.<", fixed(["String", "String"], "Bool", recordStrings)],
  ["str.<=", fixed(["String", "String"], "Bool", recordStrings)],
  ["str.at", fixed(["String", "Int"], "String", recordStringsAndInts)],
  ["str.substr", fixed(["String", "Int", "Int"], "String", recordStringsAndInts)],
  ["str.prefixof", fixed(["String", "String"], "Bool", recordStrings)],
  ["str.suffixof", fixed(["String", "String"], "Bool", recordStrings)],
  ["str.contains", fixed(["String", "String"], "Bool", recordStrings)],
  ["str.indexof", fixed(["String", "String", "Int"], "Int", recordStringsAndInts)],
  ["str.replace", fixed(["String", "String", "String"], "String", recordStrings)],
  ["str.to_int", fixed(["String"], "Int", recordStringsAndInts)],
  ["str.from_int", fixed(["Int"], "String", recordStringsAndInts)],
]);

export function isVerificationTheorySymbol(symbol: string): boolean {
  return theorySignatures.has(symbol);
}

/** Everything the sort checker needs to resolve the symbols of one problem. */
export interface VerificationSortScope {
  readonly constants: ReadonlyMap<string, VerificationSort>;
  readonly functions: ReadonlyMap<string, VerificationFunction>;
  readonly features: VerificationLogicFeatures;
  /** Functions referenced so far, in first-reference order. */
  readonly referencedFunctions: Set<string>;
  /** Every non-primitive sort the problem mentions, so the backend can declare it. */
  readonly sorts: Set<VerificationSort>;
}

/**
 * Infers the sort of an expression, checking every application against its
 * signature. Throws on an ill-sorted or unresolved term: a malformed problem
 * is a compiler bug or an invalid extension, never something to send to a
 * solver.
 */
export function inferVerificationSort(
  expression: VerificationExpression,
  scope: VerificationSortScope,
  bound: ReadonlyMap<string, VerificationSort> = new Map(),
): VerificationSort {
  switch (expression.kind) {
    case "constant": {
      const declared = scope.constants.get(expression.name);
      if (!declared) throw new Error(`Verification constant '${expression.name}' is not declared.`);
      if (!verificationSortsEqual(declared, expression.sort)) throw new Error(`Verification constant '${expression.name}' is used at a sort that differs from its declaration.`);
      recordSort(expression.sort, scope);
      return expression.sort;
    }
    case "variable": {
      const sort = bound.get(expression.name);
      if (!sort) throw new Error(`Verification variable '${expression.name}' is not bound.`);
      if (!verificationSortsEqual(sort, expression.sort)) throw new Error(`Verification variable '${expression.name}' is used at a sort that differs from its binding.`);
      return sort;
    }
    case "boolean":
      return "Bool";
    case "integer":
      scope.features.ints = true;
      return "Int";
    case "real":
      scope.features.reals = true;
      return "Real";
    case "string":
      scope.features.strings = true;
      return "String";
    case "construct": {
      recordSort(expression.sort, scope);
      const fields = expression.sort.kind === "product"
        ? expression.sort.fields
        : expression.sort.variants.find(variant => variant.name === expression.variant)?.fields;
      if (!fields) throw new Error(`Unknown constructor '${expression.variant ?? expression.sort.name}'.`);
      if (fields.length !== expression.fields.length) throw new Error(`Constructor '${expression.variant ?? expression.sort.name}' expects ${fields.length} field(s).`);
      expression.fields.forEach((field, index) => expectSort(inferVerificationSort(field, scope, bound), fields[index].sort, `Field '${fields[index].name}'`));
      return expression.sort;
    }
    case "select": {
      recordSort(expression.sort, scope);
      expectSort(inferVerificationSort(expression.target, scope, bound), expression.sort, `Selector target of '${expression.field}'`);
      const fields = expression.sort.kind === "product"
        ? expression.sort.fields
        : expression.sort.variants.find(variant => variant.name === expression.variant)?.fields;
      const field = fields?.find(candidate => candidate.name === expression.field);
      if (!field) throw new Error(`Unknown field '${expression.field}' on verification sort '${expression.sort.name}'.`);
      return field.sort;
    }
    case "is-variant":
      recordSort(expression.sort, scope);
      expectSort(inferVerificationSort(expression.target, scope, bound), expression.sort, `Tester target of '${expression.variant}'`);
      if (!expression.sort.variants.some(variant => variant.name === expression.variant)) throw new Error(`Unknown variant '${expression.variant}' on verification sort '${expression.sort.name}'.`);
      return "Bool";
    case "application":
      return inferApplicationSort(expression, scope, bound);
    case "quantifier": {
      scope.features.quantifiers = true;
      if (!expression.bindings.length) throw new Error("A quantifier must bind at least one variable.");
      const inner = bindAll(bound, expression.bindings, scope);
      expectSort(inferVerificationSort(expression.body, scope, inner), "Bool", "Quantifier body");
      for (const pattern of expression.patterns ?? []) for (const term of pattern) inferVerificationSort(term, scope, inner);
      return "Bool";
    }
    case "let": {
      if (!expression.bindings.length) throw new Error("A let expression must bind at least one variable.");
      const inner = bindAll(bound, expression.bindings.map(binding => ({ name: binding.name, sort: inferVerificationSort(binding.value, scope, bound) })), scope);
      return inferVerificationSort(expression.body, scope, inner);
    }
    case "raw":
      scope.features.raw = true;
      for (const symbol of expression.symbols) {
        if (bound.has(symbol) || scope.constants.has(symbol)) continue;
        if (!scope.functions.has(symbol)) throw new Error(`Raw SMT-LIB refers to undeclared symbol '${symbol}'.`);
        scope.referencedFunctions.add(symbol);
      }
      recordSort(expression.sort, scope);
      return expression.sort;
  }
}

function inferApplicationSort(
  expression: VerificationExpression & { readonly kind: "application"; },
  scope: VerificationSortScope,
  bound: ReadonlyMap<string, VerificationSort>,
): VerificationSort {
  const operandSorts = expression.operands.map(operand => inferVerificationSort(operand, scope, bound));
  const declared = scope.functions.get(expression.symbol);
  if (declared) {
    if (operandSorts.length !== declared.parameters.length || operandSorts.some((sort, index) => !verificationSortsEqual(sort, declared.parameters[index].sort))) {
      throw new Error(`Function '${expression.symbol}' expects (${declared.parameters.map(parameter => sortText(parameter.sort)).join(" ")}).`);
    }
    scope.referencedFunctions.add(expression.symbol);
    recordSort(declared.sort, scope);
    return declared.sort;
  }
  const signature = theorySignatures.get(expression.symbol);
  if (!signature) throw new Error(`Symbol '${expression.symbol}' is neither a standard SMT-LIB theory symbol nor a declared function.`);
  const result = signature(operandSorts, scope.features, expression.operands);
  if (isSignatureError(result)) throw new Error(`'${expression.symbol}' ${result.error}, got (${operandSorts.map(sortText).join(" ")}).`);
  return result;
}

function isSignatureError(result: SignatureResult): result is SignatureError {
  return typeof result !== "string" && hasProperty(result, "error");
}

function bindAll(
  outer: ReadonlyMap<string, VerificationSort>,
  bindings: readonly { readonly name: string; readonly sort: VerificationSort; }[],
  scope: VerificationSortScope,
): ReadonlyMap<string, VerificationSort> {
  const inner = new Map(outer);
  const names = new Set<string>();
  for (const binding of bindings) {
    if (names.has(binding.name)) throw new Error(`Variable '${binding.name}' is bound twice in one binder.`);
    names.add(binding.name);
    recordSort(binding.sort, scope);
    inner.set(binding.name, binding.sort);
  }
  return inner;
}

function recordSort(sort: VerificationSort, scope: VerificationSortScope): void {
  const features = scope.features;
  if (sort === "Int") features.ints = true;
  else if (sort === "Real") features.reals = true;
  else if (sort === "String") features.strings = true;
  else if (typeof sort !== "string") {
    scope.sorts.add(sort);
    if (isVerificationStructuredSort(sort)) features.datatypes = true;
    else features.uninterpretedFunctions = true;
  }
}

function expectSort(actual: VerificationSort, expected: VerificationSort, what: string): void {
  if (!verificationSortsEqual(actual, expected)) throw new Error(`${what} has sort ${sortText(actual)}, expected ${sortText(expected)}.`);
}

function sortText(sort: VerificationSort): string {
  return typeof sort === "string" ? sort : sort.kind === "uninterpreted" ? sort.name : verificationSortKey(sort);
}

/**
 * Standard SMT-LIB logics a problem may be classified into. A problem that
 * fits none of them, or that contains raw SMT-LIB the checker cannot
 * classify, uses `ALL`.
 */
const standardLogics = new Set([
  "QF_UF",
  "QF_LIA",
  "QF_LRA",
  "QF_NIA",
  "QF_NRA",
  "QF_LIRA",
  "QF_NIRA",
  "QF_UFLIA",
  "QF_UFLRA",
  "QF_UFNIA",
  "QF_UFNRA",
  "QF_S",
  "QF_SLIA",
  "QF_SNIA",
  "QF_DT",
  "QF_UFDT",
  "UF",
  "LIA",
  "LRA",
  "NIA",
  "NRA",
  "UFLIA",
  "UFLRA",
  "UFNIA",
  "UFNRA",
  "UFDT",
  "UFDTLIA",
  "UFDTNIA",
  "UFDTLIRA",
  "UFDTNIRA",
]);

/**
 * Picks the smallest standard logic covering the features. Dropping `QF_`
 * or adding `UF` only widens a logic, so the first standard candidate is
 * always sound to declare.
 */
export function getVerificationLogic(features: VerificationLogicFeatures): string {
  if (features.raw) return "ALL";
  const arithmetic = features.ints || features.reals
    ? (features.nonlinear ? "N" : "L") + (features.ints && features.reals ? "IRA" : features.ints ? "IA" : "RA")
    : "";
  const theories = (features.datatypes ? "DT" : "") + (features.strings ? "S" : "") + arithmetic;
  const prefix = features.quantifiers ? "" : "QF_";
  const uf = features.uninterpretedFunctions ? ["UF"] : ["", "UF"];
  for (const quantifierPrefix of prefix ? [prefix, ""] : [""]) {
    for (const functions of uf) {
      const candidate = quantifierPrefix + functions + theories;
      if (standardLogics.has(candidate)) return candidate;
    }
  }
  return "ALL";
}
