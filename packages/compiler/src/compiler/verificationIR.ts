/**
 * Solver-independent SMT IR shared by formal contracts and refinement checks.
 * This module deliberately has no dependency on the TypeScript AST or on any
 * particular solver: it models SMT-LIB 2.6 sorts, terms, declarations,
 * definitions and assertions, and the SMT-LIB backend prints it verbatim.
 *
 * Function application is open: a term applies a symbol by name, and the
 * symbol is resolved against the standard theory signatures
 * (verificationSignatures.ts) or against a function the problem declares or
 * defines. Program semantics (TypeScript/JavaScript operations) live in a
 * separate layer that lowers onto these terms.
 *
 * @internal
 */

export type VerificationPrimitiveSort = "Bool" | "Int" | "Real" | "String";

export interface VerificationField {
  readonly name: string;
  readonly sort: VerificationSort;
}

export interface VerificationProductSort {
  readonly kind: "product";
  readonly name: string;
  readonly fields: readonly VerificationField[];
}

export interface VerificationVariant {
  readonly name: string;
  readonly fields: readonly VerificationField[];
}

export interface VerificationSumSort {
  readonly kind: "sum";
  readonly name: string;
  readonly variants: readonly VerificationVariant[];
}

/** A sort introduced with `declare-sort`: it has no theory and no constructors. */
export interface VerificationUninterpretedSort {
  readonly kind: "uninterpreted";
  readonly name: string;
}

export type VerificationStructuredSort = VerificationProductSort | VerificationSumSort;

/**
 * A verification sort. Structured sorts are intentionally nominal in the IR:
 * TypeScript structural compatibility is resolved before lowering.
 */
export type VerificationSort = VerificationPrimitiveSort | VerificationStructuredSort | VerificationUninterpretedSort;

export interface VerificationBinding {
  readonly name: string;
  readonly sort: VerificationSort;
}

export type VerificationExpression =
  /** A free constant declared with `declare-const`. */
  | { readonly kind: "constant"; readonly name: string; readonly sort: VerificationSort; }
  /** A variable bound by an enclosing quantifier, `let`, or function definition. */
  | { readonly kind: "variable"; readonly name: string; readonly sort: VerificationSort; }
  | { readonly kind: "boolean"; readonly value: boolean; }
  | { readonly kind: "integer"; readonly value: string; }
  | { readonly kind: "real"; readonly value: string; }
  | { readonly kind: "string"; readonly value: string; }
  | { readonly kind: "construct"; readonly sort: VerificationStructuredSort; readonly variant?: string; readonly fields: readonly VerificationExpression[]; }
  | { readonly kind: "select"; readonly target: VerificationExpression; readonly sort: VerificationStructuredSort; readonly field: string; readonly variant?: string; }
  | { readonly kind: "is-variant"; readonly target: VerificationExpression; readonly sort: VerificationSumSort; readonly variant: string; }
  /** Applies a theory symbol or a declared/defined function. */
  | { readonly kind: "application"; readonly symbol: string; readonly operands: readonly VerificationExpression[]; }
  | {
    readonly kind: "quantifier";
    readonly quantifier: "forall" | "exists";
    readonly bindings: readonly VerificationBinding[];
    readonly body: VerificationExpression;
    /** Instantiation patterns (`:pattern`); each inner list is one multi-pattern. */
    readonly patterns?: readonly (readonly VerificationExpression[])[];
  }
  | { readonly kind: "let"; readonly bindings: readonly { readonly name: string; readonly value: VerificationExpression; }[]; readonly body: VerificationExpression; }
  /**
   * Escape hatch for SMT-LIB that has no structured constructor. The text is
   * printed verbatim; `sort` is trusted, and `symbols` lists every declared
   * or bound symbol the text refers to so declarations stay reachable.
   */
  | { readonly kind: "raw"; readonly text: string; readonly sort: VerificationSort; readonly symbols: readonly string[]; };

export interface VerificationTerm {
  readonly expression: VerificationExpression;
  readonly sort: VerificationSort;
}

export interface VerificationDeclaration {
  readonly name: string;
  readonly sort: VerificationSort;
  readonly sourceName?: string;
}

/**
 * A function symbol available to a problem. Without a body it is declared
 * (`declare-fun`, uninterpreted). With a body it is defined: a non-recursive
 * definition (`define-fun`) is a conservative extension, while a recursive
 * one (`define-fun-rec`) is only as trustworthy as an axiom, because nothing
 * checks that it terminates.
 */
export interface VerificationFunction {
  readonly name: string;
  readonly parameters: readonly VerificationBinding[];
  readonly sort: VerificationSort;
  readonly body?: VerificationExpression;
  readonly recursive?: boolean;
  /**
   * Closed Boolean formulas asserted whenever the function is reachable.
   * Axioms are trusted inputs: they are named and reported when a proof
   * depends on them, because a wrong axiom can make every goal provable.
   */
  readonly axioms?: readonly VerificationAxiom[];
  /** Where the symbol comes from, printed next to its SMT-LIB declaration. */
  readonly origin: string;
}

export interface VerificationAxiom {
  readonly label: string;
  readonly expression: VerificationExpression;
}

/**
 * Why an assertion is present. The kind decides the trust boundary: a
 * trusted assertion is accepted without proof, and a proof that depends on
 * it is only as sound as that input.
 */
export type VerificationAssertionKind =
  /** A branch condition, binding, or other consequence of program flow. */
  | "path"
  /** A `requires` clause, discharged at every verified call site. */
  | "precondition"
  /** A refinement-type predicate, discharged wherever the type is introduced. */
  | "refinement"
  /** A loop invariant, discharged by initialization and preservation obligations. */
  | "invariant"
  /** A local `assert:` that was itself emitted as an obligation. */
  | "assertion"
  /** A local `assume:`: trusted input, never proved. */
  | "assumption"
  /** A user axiom: trusted input, may make the context inconsistent. */
  | "axiom"
  /** An assumption a number model makes about program values: trusted input. */
  | "number-model";

export interface VerificationAssertionOrigin {
  readonly kind: VerificationAssertionKind;
  /** Human-readable source, such as `assume: x >= 0n (file.tspp:4:3)`. */
  readonly label?: string;
}

export interface VerificationAssertion {
  readonly expression: VerificationExpression;
  readonly origin: VerificationAssertionOrigin;
}

export interface VerificationProblem {
  readonly structuredSorts?: readonly VerificationStructuredSort[];
  readonly uninterpretedSorts?: readonly VerificationUninterpretedSort[];
  /** Functions the problem may refer to; only reachable ones are printed. */
  readonly functions?: readonly VerificationFunction[];
  readonly declarations: readonly VerificationDeclaration[];
  readonly assertions: readonly VerificationAssertion[];
  readonly goal: VerificationExpression;
  /** Modelling choices that are trusted for the whole problem, such as a number model. */
  readonly modelAssumptions?: readonly string[];
}

export function isTrustedAssertionKind(kind: VerificationAssertionKind): boolean {
  return kind === "assumption" || kind === "axiom" || kind === "number-model";
}

export function verificationAssertion(expression: VerificationExpression, kind: VerificationAssertionKind, label?: string): VerificationAssertion {
  return { expression, origin: { kind, label } };
}

export function verificationConstant(name: string, sort: VerificationSort): VerificationExpression {
  return { kind: "constant", name, sort };
}

export function verificationVariable(name: string, sort: VerificationSort): VerificationExpression {
  return { kind: "variable", name, sort };
}

export function verificationBoolean(value: boolean): VerificationExpression {
  return { kind: "boolean", value };
}

export function verificationInteger(value: string): VerificationExpression {
  return { kind: "integer", value };
}

export function verificationReal(value: string): VerificationExpression {
  return { kind: "real", value };
}

export function verificationString(value: string): VerificationExpression {
  return { kind: "string", value };
}

export function verificationApplication(symbol: string, ...operands: readonly VerificationExpression[]): VerificationExpression {
  return { kind: "application", symbol, operands };
}

export function verificationQuantifier(
  quantifier: "forall" | "exists",
  bindings: readonly VerificationBinding[],
  body: VerificationExpression,
  patterns?: readonly (readonly VerificationExpression[])[],
): VerificationExpression {
  return { kind: "quantifier", quantifier, bindings, body, patterns };
}

export function verificationLet(bindings: readonly { readonly name: string; readonly value: VerificationExpression; }[], body: VerificationExpression): VerificationExpression {
  return { kind: "let", bindings, body };
}

export function verificationRaw(text: string, sort: VerificationSort, symbols: readonly string[] = []): VerificationExpression {
  return { kind: "raw", text, sort, symbols };
}

export function verificationConstruct(
  sort: VerificationStructuredSort,
  fields: readonly VerificationExpression[],
  variant?: string,
): VerificationExpression {
  return { kind: "construct", sort, variant, fields };
}

export function verificationSelect(
  target: VerificationExpression,
  sort: VerificationStructuredSort,
  field: string,
  variant?: string,
): VerificationExpression {
  return { kind: "select", target, sort, field, variant };
}

export function verificationIsVariant(
  target: VerificationExpression,
  sort: VerificationSumSort,
  variant: string,
): VerificationExpression {
  return { kind: "is-variant", target, sort, variant };
}

export function isVerificationPrimitiveSort(sort: VerificationSort): sort is VerificationPrimitiveSort {
  return typeof sort === "string";
}

export function isVerificationStructuredSort(sort: VerificationSort): sort is VerificationStructuredSort {
  return typeof sort !== "string" && sort.kind !== "uninterpreted";
}

export function isVerificationNumericSort(sort: VerificationSort): sort is "Int" | "Real" {
  return sort === "Int" || sort === "Real";
}

/**
 * Sort keys are requested once per encoded expression node and per sort
 * comparison, so every structured sort object caches its key after the first
 * traversal. A key computed at the top of a traversal always starts from an
 * empty active path, which makes it a pure function of the sort object and
 * therefore cacheable even for recursive sorts. Keys computed for a nested
 * field depend on the active path (they contain `ref:` markers), so a nested
 * traversal only caches a key when its own subtree did not reference an
 * enclosing sort.
 */
const structuredSortRootKeys = new WeakMap<VerificationStructuredSort, string>();
const structuredSortKeys = new WeakMap<VerificationStructuredSort, string>();

interface SortKeyResult {
  readonly key: string;
  readonly sawReference: boolean;
}

export function verificationSortKey(sort: VerificationSort): string {
  if (typeof sort === "string") return sort;
  if (sort.kind === "uninterpreted") return `uninterpreted:${sort.name}`;
  let key = structuredSortRootKeys.get(sort);
  if (key === undefined) structuredSortRootKeys.set(sort, key = sortKeyWorker(sort, new Set()).key);
  return key;
}

function sortKeyWorker(sort: VerificationSort, active: Set<VerificationStructuredSort>): SortKeyResult {
  if (typeof sort === "string" || sort.kind === "uninterpreted") return { key: verificationSortKey(sort), sawReference: false };
  const cached = structuredSortKeys.get(sort);
  if (cached !== undefined) return { key: cached, sawReference: false };
  if (active.has(sort)) return { key: `ref:${sort.kind}:${sort.name}`, sawReference: true };
  active.add(sort);
  const trace = { sawReference: false };
  const members = sort.kind === "product"
    ? sort.fields.map(field => fieldKeyText(field, active, trace)).join(",")
    : sort.variants.map(variant => `${variant.name}(${variant.fields.map(field => fieldKeyText(field, active, trace)).join(",")})`).join("|");
  active.delete(sort);
  const key = `${sort.kind}:${sort.name}:${members}`;
  if (!trace.sawReference) structuredSortKeys.set(sort, key);
  return { key, sawReference: trace.sawReference };
}

function fieldKeyText(
  field: VerificationField,
  active: Set<VerificationStructuredSort>,
  trace: { sawReference: boolean; },
): string {
  const fieldKey = sortKeyWorker(field.sort, active);
  trace.sawReference ||= fieldKey.sawReference;
  return `${field.name}:${fieldKey.key}`;
}

export function verificationSortsEqual(left: VerificationSort, right: VerificationSort): boolean {
  return left === right || verificationSortKey(left) === verificationSortKey(right);
}
