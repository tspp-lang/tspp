/**
 * A small, independent Martin-Lof type theory core.
 *
 * Terms use de Bruijn indices. This module deliberately has no dependency on
 * the TypeScript assignability relation: elaborated TS++ terms will eventually
 * target this core, keeping definitional equality and normalization isolated
 * from the structural type checker.
 *
 * @internal
 */

export type MlttTerm = MlttUniverse | MlttBoolType | MlttTrue | MlttFalse | MlttBoolElim | MlttTypeMatch | MlttNatType | MlttZero | MlttSuccessor | MlttNatAdd | MlttNatElim | MlttIdentityType | MlttRefl | MlttIdentityElim | MlttSigma | MlttPair | MlttFirst | MlttSecond | MlttVariable | MlttPi | MlttLambda | MlttApplication | MlttAnnotation | MlttExternal;

export interface MlttUniverse {
  readonly kind: "universe";
  readonly level: number;
}

/** The built-in type of type-level booleans. */
export interface MlttBoolType {
  readonly kind: "bool-type";
}

export interface MlttTrue {
  readonly kind: "true";
}

export interface MlttFalse {
  readonly kind: "false";
}

/** The dependent eliminator for Bool. */
export interface MlttBoolElim {
  readonly kind: "bool-elim";
  readonly motive: MlttTerm;
  readonly trueCase: MlttTerm;
  readonly falseCase: MlttTerm;
  readonly scrutinee: MlttTerm;
}

export interface MlttTypeMatchCase {
  readonly pattern: MlttTerm;
  /** Capture binders, ordered from the nearest De Bruijn binder outwards. */
  readonly captures?: readonly MlttTypeMatchCapture[];
  readonly result: MlttTerm;
}

export interface MlttTypeMatchCapture {
  readonly name: string;
  readonly type: MlttTerm;
}

/** Ordered, non-parametric matching on the definitional shape of a type. */
export interface MlttTypeMatch {
  readonly kind: "type-match";
  readonly scrutinee: MlttTerm;
  readonly cases: readonly MlttTypeMatchCase[];
  readonly defaultCase: MlttTerm;
}

export type MlttDefinitionalComparison = "equal" | "apart" | "stuck";

/** The built-in type of unary natural numbers. */
export interface MlttNatType {
  readonly kind: "nat-type";
}

/** The zero constructor of Nat. */
export interface MlttZero {
  readonly kind: "zero";
}

/** The successor constructor of Nat. */
export interface MlttSuccessor {
  readonly kind: "successor";
  readonly predecessor: MlttTerm;
}

/** Structurally recursive addition over Nat. */
export interface MlttNatAdd {
  readonly kind: "nat-add";
  readonly left: MlttTerm;
  readonly right: MlttTerm;
}

/** The dependent eliminator for Nat. */
export interface MlttNatElim {
  readonly kind: "nat-elim";
  readonly motive: MlttTerm;
  readonly zeroCase: MlttTerm;
  readonly successorCase: MlttTerm;
  readonly scrutinee: MlttTerm;
}

/** Propositional identity between two terms of the same type. */
export interface MlttIdentityType {
  readonly kind: "identity-type";
  readonly type: MlttTerm;
  readonly left: MlttTerm;
  readonly right: MlttTerm;
}

/** Reflexivity proof for the identity type. */
export interface MlttRefl {
  readonly kind: "refl";
  readonly type: MlttTerm;
  readonly term: MlttTerm;
}

/** Path induction (the J eliminator) for the identity type. */
export interface MlttIdentityElim {
  readonly kind: "identity-elim";
  readonly type: MlttTerm;
  readonly motive: MlttTerm;
  readonly reflexivityCase: MlttTerm;
  readonly left: MlttTerm;
  readonly right: MlttTerm;
  readonly equality: MlttTerm;
}

/** A dependent pair type. The bound first component is variable zero in the codomain. */
export interface MlttSigma {
  readonly kind: "sigma";
  readonly parameterName: string;
  readonly domain: MlttTerm;
  readonly codomain: MlttTerm;
}

export interface MlttPair {
  readonly kind: "pair";
  readonly sigmaType: MlttTerm;
  readonly first: MlttTerm;
  readonly second: MlttTerm;
}

export interface MlttFirst {
  readonly kind: "first";
  readonly pair: MlttTerm;
}

export interface MlttSecond {
  readonly kind: "second";
  readonly pair: MlttTerm;
}

export interface MlttVariable {
  readonly kind: "variable";
  /** Zero refers to the nearest enclosing binder. */
  readonly index: number;
}

export interface MlttPi {
  readonly kind: "pi";
  readonly parameterName: string;
  readonly domain: MlttTerm;
  /** The bound parameter is variable zero in the codomain. */
  readonly codomain: MlttTerm;
}

export interface MlttLambda {
  readonly kind: "lambda";
  readonly parameterName: string;
  /** Optional surface annotation, checked against the expected Pi domain. */
  readonly parameterType?: MlttTerm;
  /** The bound parameter is variable zero in the body. */
  readonly body: MlttTerm;
}

export interface MlttApplication {
  readonly kind: "application";
  readonly functionTerm: MlttTerm;
  readonly argument: MlttTerm;
}

export interface MlttAnnotation {
  readonly kind: "annotation";
  readonly term: MlttTerm;
  readonly type: MlttTerm;
}

/**
 * A TypeScript type checked by the host checker and embedded in the MLTT term.
 * `arguments` records references to MLTT binders so substitution still works.
 */
export interface MlttExternal {
  readonly kind: "external";
  readonly key: string;
  readonly displayName: string;
  readonly arguments: readonly MlttTerm[];
  readonly type: MlttTerm;
  /** Host-owned semantic identity. The independent core only passes it to an equality callback. */
  readonly identity?: unknown;
}

export type MlttExternalEqualityComparer = (left: MlttExternal, right: MlttExternal) => boolean;

export type MlttTypePatternMatch =
  | { readonly kind: "matched"; readonly captures: readonly MlttTerm[]; }
  | { readonly kind: "apart" | "stuck"; };

export type MlttExternalPatternMatcher = (
  scrutinee: MlttExternal,
  pattern: MlttExternal,
  captures: readonly MlttTypeMatchCapture[],
) => MlttTypePatternMatch;

/** Types for free variables, ordered from the nearest binder outwards. */
export type MlttContext = readonly MlttTerm[];

export class MlttTypeError extends Error {
  readonly code: "cannot-infer-lambda" | "expected-function" | "expected-pair" | "expected-type" | "invalid-level" | "type-mismatch" | "unbound-variable";

  constructor(code: MlttTypeError["code"], message: string) {
    super(message);
    this.name = "MlttTypeError";
    this.code = code;
  }
}

export function mlttUniverse(level: number): MlttUniverse {
  if (!Number.isSafeInteger(level) || level < 0) {
    throw new MlttTypeError("invalid-level", `Universe level must be a non-negative safe integer; received ${level}.`);
  }
  return { kind: "universe", level };
}

export function mlttBoolType(): MlttBoolType {
  return { kind: "bool-type" };
}

export function mlttTrue(): MlttTrue {
  return { kind: "true" };
}

export function mlttFalse(): MlttFalse {
  return { kind: "false" };
}

export function mlttBoolElim(motive: MlttTerm, trueCase: MlttTerm, falseCase: MlttTerm, scrutinee: MlttTerm): MlttBoolElim {
  return { kind: "bool-elim", motive, trueCase, falseCase, scrutinee };
}

export function mlttTypeMatch(scrutinee: MlttTerm, cases: readonly MlttTypeMatchCase[], defaultCase: MlttTerm): MlttTypeMatch {
  return { kind: "type-match", scrutinee, cases, defaultCase };
}

export function mlttNatType(): MlttNatType {
  return { kind: "nat-type" };
}

export function mlttZero(): MlttZero {
  return { kind: "zero" };
}

export function mlttSuccessor(predecessor: MlttTerm): MlttSuccessor {
  return { kind: "successor", predecessor };
}

export function mlttNatAdd(left: MlttTerm, right: MlttTerm): MlttNatAdd {
  return { kind: "nat-add", left, right };
}

export function mlttNatElim(motive: MlttTerm, zeroCase: MlttTerm, successorCase: MlttTerm, scrutinee: MlttTerm): MlttNatElim {
  return { kind: "nat-elim", motive, zeroCase, successorCase, scrutinee };
}

export function mlttIdentityType(type: MlttTerm, left: MlttTerm, right: MlttTerm): MlttIdentityType {
  return { kind: "identity-type", type, left, right };
}

export function mlttRefl(type: MlttTerm, term: MlttTerm): MlttRefl {
  return { kind: "refl", type, term };
}

export function mlttIdentityElim(
  type: MlttTerm,
  motive: MlttTerm,
  reflexivityCase: MlttTerm,
  left: MlttTerm,
  right: MlttTerm,
  equality: MlttTerm,
): MlttIdentityElim {
  return { kind: "identity-elim", type, motive, reflexivityCase, left, right, equality };
}

export function mlttSigma(parameterName: string, domain: MlttTerm, codomain: MlttTerm): MlttSigma {
  return { kind: "sigma", parameterName, domain, codomain };
}

export function mlttPair(sigmaType: MlttTerm, first: MlttTerm, second: MlttTerm): MlttPair {
  return { kind: "pair", sigmaType, first, second };
}

export function mlttFirst(pair: MlttTerm): MlttFirst {
  return { kind: "first", pair };
}

export function mlttSecond(pair: MlttTerm): MlttSecond {
  return { kind: "second", pair };
}

export function mlttVariable(index: number): MlttVariable {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`Variable index must be a non-negative safe integer; received ${index}.`);
  }
  return { kind: "variable", index };
}

export function mlttPi(parameterName: string, domain: MlttTerm, codomain: MlttTerm): MlttPi {
  return { kind: "pi", parameterName, domain, codomain };
}

export function mlttLambda(parameterName: string, body: MlttTerm, parameterType?: MlttTerm): MlttLambda {
  return { kind: "lambda", parameterName, parameterType, body };
}

export function mlttApplication(functionTerm: MlttTerm, argument: MlttTerm): MlttApplication {
  return { kind: "application", functionTerm, argument };
}

export function mlttAnnotation(term: MlttTerm, type: MlttTerm): MlttAnnotation {
  return { kind: "annotation", term, type };
}

export function mlttExternal(
  key: string,
  displayName: string,
  termArguments: readonly MlttTerm[],
  type: MlttTerm,
  identity?: unknown,
): MlttExternal {
  return { kind: "external", key, displayName, arguments: termArguments, type, identity };
}

/** Infer the type of a core term. Lambdas require an expected type or an annotation. */
