import type {
  Node,
  SourceFile,
  Symbol,
} from "./types.js";
import {
  verificationApplication,
  VerificationExpression,
  VerificationFunction,
  verificationInteger,
  verificationReal,
  verificationVariable,
} from "./verificationIR.js";

/** @internal */
export type StandardPredicateName =
  | "isEven"
  | "isOdd"
  | "isPositive"
  | "isNegative"
  | "isNonNegative"
  | "isZero"
  | "divides"
  | "between";

/** @internal */
export type StandardPredicateKind =
  | "even"
  | "odd"
  | "positive"
  | "negative"
  | "nonNegative"
  | "zero"
  | "divides"
  | "between";

/** @internal */
export interface StandardPredicateDefinition {
  readonly name: StandardPredicateName;
  readonly kind: StandardPredicateKind;
  readonly arity: number;
}

/** @internal */

export const standardPredicateDefinitions: readonly StandardPredicateDefinition[] = [
  { name: "isEven", kind: "even", arity: 1 },
  { name: "isOdd", kind: "odd", arity: 1 },
  { name: "isPositive", kind: "positive", arity: 1 },
  { name: "isNegative", kind: "negative", arity: 1 },
  { name: "isNonNegative", kind: "nonNegative", arity: 1 },
  { name: "isZero", kind: "zero", arity: 1 },
  { name: "divides", kind: "divides", arity: 2 },
  { name: "between", kind: "between", arity: 3 },
];

const standardPredicateMap = new Map<string, StandardPredicateDefinition>(
  standardPredicateDefinitions.map(definition => [definition.name, definition]),
);

/** @internal */
export function getStandardPredicateDefinition(name: string): StandardPredicateDefinition | undefined {
  return standardPredicateMap.get(name);
}

/** @internal */
export function isStandardPredicateSymbol(symbol: Symbol | undefined): boolean {
  if (!symbol) return false;
  // A declarationless symbol is synthesized by the checker for noLib hosts.
  if (!symbol.declarations?.length) return true;
  return symbol.declarations.some(declaration => {
    let root: Node = declaration;
    while (root.parent) root = root.parent;
    const sourceFile = root as SourceFile;
    const fileName = sourceFile.fileName.replace(/\\/g, "/");
    return fileName === "lib.tspp.d.ts" || fileName.endsWith("/lib.tspp.d.ts");
  });
}

const standardPredicateFunctions = new Map<string, VerificationFunction>();

/**
 * The logic definition of a standard predicate over one numeric sort. Each
 * predicate is an ordinary non-recursive `define-fun` in the verification
 * library, so the generated SMT-LIB shows exactly what it means.
 *
 * @internal
 */
export function getStandardPredicateFunction(definition: StandardPredicateDefinition, sort: "Int" | "Real"): VerificationFunction {
  const name = `tspp.std.${definition.name}.${sort}`;
  let result = standardPredicateFunctions.get(name);
  if (!result) {
    const parameterNames = definition.arity === 1 ? ["value"] : definition.kind === "divides" ? ["divisor", "value"] : ["value", "lower", "upper"];
    const parameters = parameterNames.map(parameterName => ({ name: parameterName, sort }));
    const [first, second, third] = parameters.map(parameter => verificationVariable(parameter.name, sort));
    result = {
      name,
      parameters,
      sort: "Bool",
      body: getStandardPredicateBody(definition.kind, sort, first, second, third),
      origin: `TS++ standard predicate ${definition.name} over ${sort} (lib.tspp.d.ts)`,
    };
    standardPredicateFunctions.set(name, result);
  }
  return result;
}

function getStandardPredicateBody(
  kind: StandardPredicateKind,
  sort: "Int" | "Real",
  first: VerificationExpression,
  second: VerificationExpression,
  third: VerificationExpression,
): VerificationExpression {
  const zero = sort === "Real" ? verificationReal("0") : verificationInteger("0");
  // Parity and divisibility are integer notions: a Real argument must be integral.
  const integer = (value: VerificationExpression) => sort === "Int" ? value : verificationApplication("to_int", value);
  const integral = (body: VerificationExpression, ...values: VerificationExpression[]) => sort === "Int" ? body : verificationApplication("and", ...values.map(value => verificationApplication("is_int", value)), body);
  switch (kind) {
    case "even":
    case "odd":
      return integral(verificationApplication("=", verificationApplication("mod", integer(first), verificationInteger("2")), verificationInteger(kind === "even" ? "0" : "1")), first);
    case "positive":
      return verificationApplication(">", first, zero);
    case "negative":
      return verificationApplication("<", first, zero);
    case "nonNegative":
      return verificationApplication(">=", first, zero);
    case "zero":
      return verificationApplication("=", first, zero);
    case "divides":
      return integral(
        verificationApplication(
          "and",
          verificationApplication("not", verificationApplication("=", first, zero)),
          verificationApplication("=", verificationApplication("mod", integer(second), integer(first)), verificationInteger("0")),
        ),
        first,
        second,
      );
    case "between":
      return verificationApplication("and", verificationApplication(">=", first, second), verificationApplication("<=", first, third));
  }
}
