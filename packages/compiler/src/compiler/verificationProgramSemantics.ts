import {
  verificationApplication,
  VerificationExpression,
  VerificationFunction,
  verificationInteger,
  verificationReal,
  VerificationTerm,
  verificationVariable,
} from "./verificationIR.js";

/*
 * Program semantics: how TypeScript/JavaScript operations are modelled in
 * the SMT IR. An operation lowers to a logic term together with the
 * definedness obligations its runtime behaviour requires; it never picks an
 * SMT operator just because it looks similar. For example bigint `%` is
 * JavaScript's truncated remainder and throws for a zero divisor, while SMT
 * `mod` is the Euclidean remainder and is unspecified for zero.
 */

/**
 * How TypeScript `number` values are modelled. Without a model, `number` is
 * outside the verification subset.
 *
 * - `mathematical-real`: a number is a mathematical real. Rounding, overflow,
 *   NaN, Infinity and -0 are not modelled, so this is a trusted modelling
 *   assumption and every proof under it reports it.
 * - `safe-integer`: a number is an integer in
 *   [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], where IEEE-754
 *   arithmetic is exact. Every operation must provably stay in that range;
 *   only the range of inputs (parameters) is trusted.
 */
export type VerificationNumberModel = "mathematical-real" | "safe-integer";

export const verificationNumberModels: readonly VerificationNumberModel[] = ["mathematical-real", "safe-integer"];

/** The numeric domain of a TypeScript operation. */
export type ProgramNumericDomain = "bigint" | "number";

export type ProgramArithmeticOperator = "+" | "-" | "*" | "/" | "%";

export interface ProgramObligation {
  readonly obligation: "nonzero-divisor" | "safe-integer-range";
  readonly goal: VerificationExpression;
  readonly description: string;
}

export interface ProgramOperationResult {
  readonly term: VerificationTerm;
  readonly obligations: readonly ProgramObligation[];
  /** Library definitions the term applies. */
  readonly functions: readonly VerificationFunction[];
}

const maximumSafeInteger = "9007199254740991";

export function isVerificationNumberModel(text: string): text is VerificationNumberModel {
  return (verificationNumberModels as readonly string[]).includes(text);
}

export function getNumberModelSort(model: VerificationNumberModel): "Int" | "Real" {
  return model === "safe-integer" ? "Int" : "Real";
}

/** The trusted assumption a number model makes for a whole problem, if any. */
export function getNumberModelAssumption(model: VerificationNumberModel | undefined): string | undefined {
  return model === "mathematical-real"
    ? 'numberModel "mathematical-real": number is modelled as a mathematical real; rounding, overflow, NaN, Infinity and -0 are not modelled'
    : undefined;
}

/** The fact that a safe-integer `number` value lies in the exactly representable range. */
export function getSafeIntegerRangeFact(value: VerificationExpression): VerificationExpression {
  return verificationApplication(
    "and",
    verificationApplication("<=", verificationApplication("-", verificationInteger(maximumSafeInteger)), value),
    verificationApplication("<=", value, verificationInteger(maximumSafeInteger)),
  );
}

/** Lowers a numeric literal of the given domain, or explains why it is outside the model. */
export function lowerNumericLiteral(text: string, domain: ProgramNumericDomain, model: VerificationNumberModel | undefined): VerificationTerm | string {
  if (domain === "bigint") return { sort: "Int", expression: verificationInteger(text.replace(/n$/i, "")) };
  if (!model) return 'TypeScript number requires a numberModel ("mathematical-real" or "safe-integer").';
  if (model === "mathematical-real") {
    if (!/^\d+(?:\.\d+)?$/.test(text)) return `Numeric literal '${text}' is outside the mathematical-real encoding subset.`;
    return { sort: "Real", expression: verificationReal(text) };
  }
  if (!/^\d+$/.test(text) || BigInt(text) > BigInt(maximumSafeInteger)) return `Numeric literal '${text}' is not a safe integer.`;
  return { sort: "Int", expression: verificationInteger(text) };
}

/**
 * Lowers `left <operator> right` for operands that already have the model's
 * sort. Returns a reason string when the operation has no model in the
 * given domain.
 */
export function lowerArithmetic(
  operator: ProgramArithmeticOperator,
  left: VerificationTerm,
  right: VerificationTerm,
  domain: ProgramNumericDomain,
  model: VerificationNumberModel | undefined,
  sourceText: string,
): ProgramOperationResult | string {
  const sort = left.sort;
  if (sort !== "Int" && sort !== "Real") return `Operator '${operator}' requires numeric SMT operands.`;
  const safeInteger = domain === "number" && model === "safe-integer";
  if (operator === "+" || operator === "-" || operator === "*") {
    const expression = verificationApplication(operator, left.expression, right.expression);
    return {
      term: { sort, expression },
      obligations: safeInteger ? [rangeObligation(expression, sourceText)] : [],
      functions: [],
    };
  }
  const divisorObligations = isNonzeroLiteral(right.expression) ? [] : [{
    obligation: "nonzero-divisor" as const,
    goal: verificationApplication("not", verificationApplication("=", right.expression, sort === "Real" ? verificationReal("0") : verificationInteger("0"))),
    description: `divisor of '${sourceText}' is non-zero`,
  }];
  if (domain === "number" && model === "mathematical-real") {
    if (operator === "%") return `Operator '%' on number is outside the mathematical-real model.`;
    // JavaScript yields ±Infinity or NaN for a zero divisor, which the real model excludes.
    return { term: { sort, expression: verificationApplication("/", left.expression, right.expression) }, obligations: divisorObligations, functions: [] };
  }
  if (domain === "number" && operator === "/") return "Operator '/' on number is not integer division and is outside the safe-integer model.";
  // bigint `/` and `%`, and safe-integer `%`: JavaScript truncates toward zero.
  // A safe-integer remainder is bounded by its dividend, so it needs no range obligation.
  const definition = operator === "/" ? truncatedDivision : truncatedRemainder;
  return {
    term: { sort: "Int", expression: verificationApplication(definition.name, left.expression, right.expression) },
    obligations: divisorObligations,
    functions: [definition],
  };
}

/** Lowers unary `-`. Negation is exact in every model, and the safe-integer range is symmetric. */
export function lowerNegation(operand: VerificationTerm): VerificationTerm | string {
  if (operand.sort !== "Int" && operand.sort !== "Real") return "Unary '-' requires a numeric SMT operand.";
  return { sort: operand.sort, expression: verificationApplication("-", operand.expression) };
}

function rangeObligation(expression: VerificationExpression, sourceText: string): ProgramObligation {
  return {
    obligation: "safe-integer-range",
    goal: getSafeIntegerRangeFact(expression),
    description: `'${sourceText}' stays within the safe-integer range`,
  };
}

function isNonzeroLiteral(expression: VerificationExpression): boolean {
  if (expression.kind === "application" && expression.symbol === "-" && expression.operands.length === 1) return isNonzeroLiteral(expression.operands[0]);
  return (expression.kind === "integer" || expression.kind === "real") && !/^-?0*(?:\.0*)?$/.test(expression.value);
}

const a = verificationVariable("a", "Int");
const b = verificationVariable("b", "Int");
const absoluteB = verificationApplication("abs", b);

/**
 * JavaScript `/` on bigint: truncation toward zero. For b != 0,
 * sign(a) * sign(b) * floor(|a| / |b|); SMT `div` by a positive divisor is
 * floor division, so `div` of the absolute values is the truncated magnitude.
 */
export const truncatedDivision: VerificationFunction = {
  name: "tspp.js.trunc.div",
  parameters: [{ name: "a", sort: "Int" }, { name: "b", sort: "Int" }],
  sort: "Int",
  body: verificationApplication(
    "ite",
    verificationApplication("=", verificationApplication(">=", a, verificationInteger("0")), verificationApplication(">", b, verificationInteger("0"))),
    verificationApplication("div", verificationApplication("abs", a), absoluteB),
    verificationApplication("-", verificationApplication("div", verificationApplication("abs", a), absoluteB)),
  ),
  origin: "TS++ program semantics: JavaScript bigint '/' (truncates toward zero; callers prove b != 0)",
};

/**
 * JavaScript `%` on integers: the remainder takes the sign of the dividend,
 * e.g. -3n % 2n === -1n, whereas SMT `mod` is always non-negative.
 */
export const truncatedRemainder: VerificationFunction = {
  name: "tspp.js.trunc.rem",
  parameters: [{ name: "a", sort: "Int" }, { name: "b", sort: "Int" }],
  sort: "Int",
  body: verificationApplication(
    "ite",
    verificationApplication(">=", a, verificationInteger("0")),
    verificationApplication("mod", a, absoluteB),
    verificationApplication("-", verificationApplication("mod", verificationApplication("-", a), absoluteB)),
  ),
  origin: "TS++ program semantics: JavaScript integer '%' (sign of the dividend; callers prove b != 0)",
};
