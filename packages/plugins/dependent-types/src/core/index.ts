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
export function inferMlttType(term: MlttTerm, context: MlttContext = []): MlttTerm {
  switch (term.kind) {
    case "universe":
      return mlttUniverse(term.level + 1);

    case "bool-type":
      return mlttUniverse(0);

    case "true":
    case "false":
      return mlttBoolType();

    case "bool-elim": {
      const motiveType = weakHeadNormalizeMltt(inferMlttType(term.motive, context));
      if (motiveType.kind !== "pi" || !areMlttTermsDefinitionallyEqual(motiveType.domain, mlttBoolType())) {
        throw new MlttTypeError("type-mismatch", "Expected the Bool eliminator motive to have a Pi type over Bool.");
      }
      if (weakHeadNormalizeMltt(motiveType.codomain).kind !== "universe") {
        throw new MlttTypeError("expected-type", "Expected the Bool eliminator motive to return a type.");
      }
      checkMlttType(term.trueCase, mlttApplication(term.motive, mlttTrue()), context);
      checkMlttType(term.falseCase, mlttApplication(term.motive, mlttFalse()), context);
      checkMlttType(term.scrutinee, mlttBoolType(), context);
      return mlttApplication(term.motive, term.scrutinee);
    }

    case "type-match": {
      const scrutineeLevel = inferMlttUniverseLevel(term.scrutinee, context);
      const resultLevel = inferMlttUniverseLevel(term.defaultCase, context);
      for (const matchCase of term.cases) {
        const captures = matchCase.captures ?? [];
        const caseContext: MlttContext = [...captures.map(capture => capture.type), ...context];
        const patternLevel = inferMlttUniverseLevel(matchCase.pattern, caseContext);
        if (patternLevel !== scrutineeLevel) {
          throw new MlttTypeError(
            "type-mismatch",
            `Type-match pattern ${printMlttTerm(matchCase.pattern)} belongs to Type${patternLevel}, but the scrutinee belongs to Type${scrutineeLevel}.`,
          );
        }
        const caseResultLevel = inferMlttUniverseLevel(matchCase.result, caseContext);
        if (caseResultLevel !== resultLevel) {
          throw new MlttTypeError(
            "type-mismatch",
            `Type-match result ${printMlttTerm(matchCase.result)} belongs to Type${caseResultLevel}, but the default result belongs to Type${resultLevel}.`,
          );
        }
      }
      return mlttUniverse(resultLevel);
    }

    case "nat-type":
      return mlttUniverse(0);

    case "zero":
      return mlttNatType();

    case "successor":
      checkMlttType(term.predecessor, mlttNatType(), context);
      return mlttNatType();

    case "nat-add":
      checkMlttType(term.left, mlttNatType(), context);
      checkMlttType(term.right, mlttNatType(), context);
      return mlttNatType();

    case "nat-elim": {
      const motiveType = weakHeadNormalizeMltt(inferMlttType(term.motive, context));
      if (motiveType.kind !== "pi" || !areMlttTermsDefinitionallyEqual(motiveType.domain, mlttNatType())) {
        throw new MlttTypeError("type-mismatch", `Expected the Nat eliminator motive to have a Pi type over Nat.`);
      }
      if (weakHeadNormalizeMltt(motiveType.codomain).kind !== "universe") {
        throw new MlttTypeError("expected-type", "Expected the Nat eliminator motive to return a type.");
      }
      const motiveAtZero = mlttApplication(term.motive, mlttZero());
      checkMlttType(term.zeroCase, motiveAtZero, context);

      const shiftedMotive = shiftMlttTerm(term.motive, 1);
      const successorType = mlttPi(
        "n",
        mlttNatType(),
        mlttPi(
          "previous",
          mlttApplication(shiftedMotive, mlttVariable(0)),
          mlttApplication(shiftMlttTerm(term.motive, 2), mlttSuccessor(mlttVariable(1))),
        ),
      );
      checkMlttType(term.successorCase, successorType, context);
      checkMlttType(term.scrutinee, mlttNatType(), context);
      return mlttApplication(term.motive, term.scrutinee);
    }

    case "identity-type": {
      const level = inferMlttUniverseLevel(term.type, context);
      checkMlttType(term.left, term.type, context);
      checkMlttType(term.right, term.type, context);
      return mlttUniverse(level);
    }

    case "refl":
      inferMlttUniverseLevel(term.type, context);
      checkMlttType(term.term, term.type, context);
      return mlttIdentityType(term.type, term.term, term.term);

    case "identity-elim": {
      inferMlttUniverseLevel(term.type, context);
      checkMlttType(term.left, term.type, context);
      checkMlttType(term.right, term.type, context);
      checkMlttType(term.equality, mlttIdentityType(term.type, term.left, term.right), context);

      const motiveType = weakHeadNormalizeMltt(inferMlttType(term.motive, context));
      if (motiveType.kind !== "pi" || !areMlttTermsDefinitionallyEqual(motiveType.domain, term.type)) {
        throw new MlttTypeError("type-mismatch", "Expected the identity eliminator motive to abstract over the left endpoint.");
      }
      const motiveAtLeftType = weakHeadNormalizeMltt(motiveType.codomain);
      if (motiveAtLeftType.kind !== "pi" || !areMlttTermsDefinitionallyEqual(motiveAtLeftType.domain, shiftMlttTerm(term.type, 1))) {
        throw new MlttTypeError("type-mismatch", "Expected the identity eliminator motive to abstract over the right endpoint.");
      }
      const motiveAtEndpointsType = weakHeadNormalizeMltt(motiveAtLeftType.codomain);
      const expectedEqualityDomain = mlttIdentityType(shiftMlttTerm(term.type, 2), mlttVariable(1), mlttVariable(0));
      if (motiveAtEndpointsType.kind !== "pi" || !areMlttTermsDefinitionallyEqual(motiveAtEndpointsType.domain, expectedEqualityDomain)) {
        throw new MlttTypeError("type-mismatch", "Expected the identity eliminator motive to abstract over an equality proof.");
      }
      if (weakHeadNormalizeMltt(motiveAtEndpointsType.codomain).kind !== "universe") {
        throw new MlttTypeError("expected-type", "Expected the identity eliminator motive to return a type.");
      }

      const shiftedType = shiftMlttTerm(term.type, 1);
      const shiftedMotive = shiftMlttTerm(term.motive, 1);
      const variable = mlttVariable(0);
      const reflexivityResult = mlttApplication(
        mlttApplication(
          mlttApplication(shiftedMotive, variable),
          variable,
        ),
        mlttRefl(shiftedType, variable),
      );
      checkMlttType(term.reflexivityCase, mlttPi("value", term.type, reflexivityResult), context);
      return mlttApplication(
        mlttApplication(
          mlttApplication(term.motive, term.left),
          term.right,
        ),
        term.equality,
      );
    }

    case "sigma": {
      const domainLevel = inferMlttUniverseLevel(term.domain, context);
      const codomainLevel = inferMlttUniverseLevel(term.codomain, extendContext(context, term.domain));
      return mlttUniverse(Math.max(domainLevel, codomainLevel));
    }

    case "pair": {
      inferMlttUniverseLevel(term.sigmaType, context);
      const sigmaType = weakHeadNormalizeMltt(term.sigmaType);
      if (sigmaType.kind !== "sigma") {
        throw new MlttTypeError("expected-pair", `Expected a Sigma type, but found ${printMlttTerm(sigmaType)}.`);
      }
      checkMlttType(term.first, sigmaType.domain, context);
      checkMlttType(term.second, substituteMlttTop(term.first, sigmaType.codomain), context);
      return term.sigmaType;
    }

    case "first": {
      const pairType = weakHeadNormalizeMltt(inferMlttType(term.pair, context));
      if (pairType.kind !== "sigma") {
        throw new MlttTypeError("expected-pair", `Expected a Sigma pair, but found ${printMlttTerm(pairType)}.`);
      }
      return pairType.domain;
    }

    case "second": {
      const pairType = weakHeadNormalizeMltt(inferMlttType(term.pair, context));
      if (pairType.kind !== "sigma") {
        throw new MlttTypeError("expected-pair", `Expected a Sigma pair, but found ${printMlttTerm(pairType)}.`);
      }
      return substituteMlttTop(mlttFirst(term.pair), pairType.codomain);
    }

    case "variable": {
      const type = context[term.index];
      if (!type) {
        throw new MlttTypeError("unbound-variable", `Variable ${term.index} is not bound in a context of size ${context.length}.`);
      }
      // A binding was recorded before each binder between it and this use.
      return shiftMlttTerm(type, term.index + 1);
    }

    case "pi": {
      const domainLevel = inferMlttUniverseLevel(term.domain, context);
      const codomainLevel = inferMlttUniverseLevel(term.codomain, extendContext(context, term.domain));
      return mlttUniverse(Math.max(domainLevel, codomainLevel));
    }

    case "lambda":
      throw new MlttTypeError("cannot-infer-lambda", "Cannot infer a lambda type without an expected Pi type or an annotation.");

    case "application": {
      const functionType = weakHeadNormalizeMltt(inferMlttType(term.functionTerm, context));
      if (functionType.kind !== "pi") {
        throw new MlttTypeError("expected-function", `Expected a function type, but found ${printMlttTerm(functionType)}.`);
      }
      checkMlttType(term.argument, functionType.domain, context);
      return substituteMlttTop(term.argument, functionType.codomain);
    }

    case "annotation":
      inferMlttUniverseLevel(term.type, context);
      checkMlttType(term.term, term.type, context);
      return term.type;

    case "external":
      return term.type;
  }
}

/** Check a term against an expected type. */
export function checkMlttType(term: MlttTerm, expectedType: MlttTerm, context: MlttContext = []): void {
  const normalizedExpected = weakHeadNormalizeMltt(expectedType);
  if (term.kind === "lambda" && normalizedExpected.kind === "pi") {
    if (term.parameterType && !areMlttTermsDefinitionallyEqual(term.parameterType, normalizedExpected.domain)) {
      throw new MlttTypeError(
        "type-mismatch",
        `Lambda parameter annotation ${printMlttTerm(term.parameterType)} does not match expected domain ${printMlttTerm(normalizedExpected.domain)}.`,
      );
    }
    checkMlttType(term.body, normalizedExpected.codomain, extendContext(context, normalizedExpected.domain));
    return;
  }

  const actualType = inferMlttType(term, context);
  if (!areMlttTermsDefinitionallyEqual(actualType, expectedType)) {
    throw new MlttTypeError(
      "type-mismatch",
      `Expected ${printMlttTerm(expectedType)}, but inferred ${printMlttTerm(actualType)}.`,
    );
  }
}

/** Reduce only far enough to expose the outer constructor. */
export function weakHeadNormalizeMltt(
  term: MlttTerm,
  compareExternal?: MlttExternalEqualityComparer,
  matchExternalPattern?: MlttExternalPatternMatcher,
): MlttTerm {
  let current = term;
  while (true) {
    if (current.kind === "annotation") {
      current = current.term;
      continue;
    }
    if (current.kind === "bool-elim") {
      const scrutinee = weakHeadNormalizeMltt(current.scrutinee, compareExternal, matchExternalPattern);
      if (scrutinee.kind === "true") {
        current = current.trueCase;
        continue;
      }
      if (scrutinee.kind === "false") {
        current = current.falseCase;
        continue;
      }
      return scrutinee === current.scrutinee
        ? current
        : mlttBoolElim(current.motive, current.trueCase, current.falseCase, scrutinee);
    }
    if (current.kind === "type-match") {
      const typeMatch = current;
      const scrutinee = weakHeadNormalizeMltt(typeMatch.scrutinee, compareExternal, matchExternalPattern);
      let matched = false;
      for (const matchCase of typeMatch.cases) {
        const captures = matchCase.captures ?? [];
        if (captures.length) {
          if (scrutinee.kind === "variable" || hasFreeMlttVariable(scrutinee)) {
            return scrutinee === typeMatch.scrutinee
              ? typeMatch
              : mlttTypeMatch(scrutinee, typeMatch.cases, typeMatch.defaultCase);
          }
          if (scrutinee.kind !== "external" || matchCase.pattern.kind !== "external" || !matchExternalPattern) {
            return scrutinee === typeMatch.scrutinee
              ? typeMatch
              : mlttTypeMatch(scrutinee, typeMatch.cases, typeMatch.defaultCase);
          }
          const patternMatch = matchExternalPattern(scrutinee, matchCase.pattern, captures);
          if (patternMatch.kind === "matched") {
            current = substituteMlttTypeMatchCaptures(matchCase.result, patternMatch.captures);
            matched = true;
            break;
          }
          if (patternMatch.kind === "stuck") {
            return scrutinee === typeMatch.scrutinee
              ? typeMatch
              : mlttTypeMatch(scrutinee, typeMatch.cases, typeMatch.defaultCase);
          }
          continue;
        }
        const comparison = compareMlttTermsDefinitionally(scrutinee, matchCase.pattern, compareExternal);
        if (comparison === "equal") {
          current = matchCase.result;
          matched = true;
          break;
        }
        if (comparison === "stuck") {
          return scrutinee === typeMatch.scrutinee
            ? typeMatch
            : mlttTypeMatch(scrutinee, typeMatch.cases, typeMatch.defaultCase);
        }
      }
      if (matched) continue;
      current = typeMatch.defaultCase;
      continue;
    }
    if (current.kind === "nat-add") {
      const left = weakHeadNormalizeMltt(current.left, compareExternal, matchExternalPattern);
      if (left.kind === "zero") {
        current = current.right;
        continue;
      }
      if (left.kind === "successor") {
        current = mlttSuccessor(mlttNatAdd(left.predecessor, current.right));
        continue;
      }
      return left === current.left ? current : mlttNatAdd(left, current.right);
    }
    if (current.kind === "nat-elim") {
      const scrutinee = weakHeadNormalizeMltt(current.scrutinee, compareExternal, matchExternalPattern);
      if (scrutinee.kind === "zero") {
        current = current.zeroCase;
        continue;
      }
      if (scrutinee.kind === "successor") {
        current = mlttApplication(
          mlttApplication(current.successorCase, scrutinee.predecessor),
          mlttNatElim(current.motive, current.zeroCase, current.successorCase, scrutinee.predecessor),
        );
        continue;
      }
      return scrutinee === current.scrutinee
        ? current
        : mlttNatElim(current.motive, current.zeroCase, current.successorCase, scrutinee);
    }
    if (current.kind === "identity-elim") {
      const equality = weakHeadNormalizeMltt(current.equality, compareExternal, matchExternalPattern);
      if (equality.kind === "refl") {
        current = mlttApplication(current.reflexivityCase, equality.term);
        continue;
      }
      return equality === current.equality
        ? current
        : mlttIdentityElim(current.type, current.motive, current.reflexivityCase, current.left, current.right, equality);
    }
    if (current.kind === "first" || current.kind === "second") {
      const pair = weakHeadNormalizeMltt(current.pair, compareExternal, matchExternalPattern);
      if (pair.kind === "pair") {
        current = current.kind === "first" ? pair.first : pair.second;
        continue;
      }
      return pair === current.pair ? current : current.kind === "first" ? mlttFirst(pair) : mlttSecond(pair);
    }
    if (current.kind !== "application") return current;

    const functionTerm = weakHeadNormalizeMltt(current.functionTerm, compareExternal, matchExternalPattern);
    if (functionTerm.kind !== "lambda") {
      return functionTerm === current.functionTerm ? current : mlttApplication(functionTerm, current.argument);
    }
    current = substituteMlttTop(current.argument, functionTerm.body);
  }
}

function substituteMlttTypeMatchCaptures(body: MlttTerm, captures: readonly MlttTerm[]): MlttTerm {
  let result = body;
  for (const capture of captures) {
    result = substituteMlttTop(capture, result);
  }
  return result;
}

/** Compute a beta-normal form. Binder names are retained only for diagnostics. */
export function normalizeMlttTerm(
  term: MlttTerm,
  compareExternal?: MlttExternalEqualityComparer,
  matchExternalPattern?: MlttExternalPatternMatcher,
): MlttTerm {
  const head = weakHeadNormalizeMltt(term, compareExternal, matchExternalPattern);
  const normalize = (nested: MlttTerm) => normalizeMlttTerm(nested, compareExternal, matchExternalPattern);
  switch (head.kind) {
    case "universe":
    case "bool-type":
    case "true":
    case "false":
    case "nat-type":
    case "zero":
    case "variable":
      return head;
    case "bool-elim":
      return mlttBoolElim(
        normalize(head.motive),
        normalize(head.trueCase),
        normalize(head.falseCase),
        normalize(head.scrutinee),
      );
    case "type-match":
      return mlttTypeMatch(
        normalize(head.scrutinee),
        head.cases.map(matchCase => ({
          pattern: normalize(matchCase.pattern),
          ...(matchCase.captures ? { captures: matchCase.captures.map(capture => ({ ...capture, type: normalize(capture.type) })) } : {}),
          result: normalize(matchCase.result),
        })),
        normalize(head.defaultCase),
      );
    case "successor":
      return mlttSuccessor(normalize(head.predecessor));
    case "nat-add":
      return mlttNatAdd(normalize(head.left), normalize(head.right));
    case "nat-elim":
      return mlttNatElim(
        normalize(head.motive),
        normalize(head.zeroCase),
        normalize(head.successorCase),
        normalize(head.scrutinee),
      );
    case "identity-type":
      return mlttIdentityType(normalize(head.type), normalize(head.left), normalize(head.right));
    case "refl":
      return mlttRefl(normalize(head.type), normalize(head.term));
    case "identity-elim":
      return mlttIdentityElim(
        normalize(head.type),
        normalize(head.motive),
        normalize(head.reflexivityCase),
        normalize(head.left),
        normalize(head.right),
        normalize(head.equality),
      );
    case "sigma":
      return mlttSigma(head.parameterName, normalize(head.domain), normalize(head.codomain));
    case "pair":
      return mlttPair(normalize(head.sigmaType), normalize(head.first), normalize(head.second));
    case "first":
      return mlttFirst(normalize(head.pair));
    case "second":
      return mlttSecond(normalize(head.pair));
    case "pi":
      return mlttPi(head.parameterName, normalize(head.domain), normalize(head.codomain));
    case "lambda":
      return mlttLambda(head.parameterName, normalize(head.body), head.parameterType && normalize(head.parameterType));
    case "application":
      return mlttApplication(normalize(head.functionTerm), normalize(head.argument));
    case "annotation":
      // weakHeadNormalizeMltt always removes an outer annotation.
      return normalize(head.term);
    case "external":
      return mlttExternal(head.key, head.displayName, head.arguments.map(normalize), normalize(head.type), head.identity);
  }
}

/** Definitional equality includes alpha/beta equality and the computation rules of the built-in eliminators. */
export function areMlttTermsDefinitionallyEqual(
  left: MlttTerm,
  right: MlttTerm,
  compareExternal?: MlttExternalEqualityComparer,
  matchExternalPattern?: MlttExternalPatternMatcher,
): boolean {
  return structurallyEqualMlttTerms(
    normalizeMlttTerm(left, compareExternal, matchExternalPattern),
    normalizeMlttTerm(right, compareExternal, matchExternalPattern),
    compareExternal,
  );
}

/** Decide equality when possible without treating an open neutral term as unequal. */
export function compareMlttTermsDefinitionally(
  left: MlttTerm,
  right: MlttTerm,
  compareExternal?: MlttExternalEqualityComparer,
  matchExternalPattern?: MlttExternalPatternMatcher,
): MlttDefinitionalComparison {
  const normalizedLeft = normalizeMlttTerm(left, compareExternal, matchExternalPattern);
  const normalizedRight = normalizeMlttTerm(right, compareExternal, matchExternalPattern);
  if (structurallyEqualMlttTerms(normalizedLeft, normalizedRight, compareExternal)) return "equal";
  return hasFreeMlttVariable(normalizedLeft) || hasFreeMlttVariable(normalizedRight) ? "stuck" : "apart";
}

export function printMlttTerm(term: MlttTerm): string {
  return printMlttTermWorker(term, []);
}

function inferMlttUniverseLevel(term: MlttTerm, context: MlttContext): number {
  const type = weakHeadNormalizeMltt(inferMlttType(term, context));
  if (type.kind !== "universe") {
    throw new MlttTypeError("expected-type", `Expected a type, but ${printMlttTerm(term)} has type ${printMlttTerm(type)}.`);
  }
  return type.level;
}

function extendContext(context: MlttContext, type: MlttTerm): MlttContext {
  return [type, ...context];
}

function hasFreeMlttVariable(term: MlttTerm, binderDepth = 0): boolean {
  switch (term.kind) {
    case "universe":
    case "bool-type":
    case "true":
    case "false":
    case "nat-type":
    case "zero":
      return false;
    case "variable":
      return term.index >= binderDepth;
    case "bool-elim":
      return hasFreeMlttVariable(term.motive, binderDepth) || hasFreeMlttVariable(term.trueCase, binderDepth) ||
        hasFreeMlttVariable(term.falseCase, binderDepth) || hasFreeMlttVariable(term.scrutinee, binderDepth);
    case "type-match":
      return hasFreeMlttVariable(term.scrutinee, binderDepth) ||
        term.cases.some(matchCase => {
          const captureDepth = binderDepth + (matchCase.captures?.length ?? 0);
          return matchCase.captures?.some(capture => hasFreeMlttVariable(capture.type, binderDepth)) ||
            hasFreeMlttVariable(matchCase.pattern, captureDepth) ||
            hasFreeMlttVariable(matchCase.result, captureDepth);
        }) ||
        hasFreeMlttVariable(term.defaultCase, binderDepth);
    case "successor":
      return hasFreeMlttVariable(term.predecessor, binderDepth);
    case "nat-add":
      return hasFreeMlttVariable(term.left, binderDepth) || hasFreeMlttVariable(term.right, binderDepth);
    case "nat-elim":
      return hasFreeMlttVariable(term.motive, binderDepth) || hasFreeMlttVariable(term.zeroCase, binderDepth) ||
        hasFreeMlttVariable(term.successorCase, binderDepth) || hasFreeMlttVariable(term.scrutinee, binderDepth);
    case "identity-type":
      return hasFreeMlttVariable(term.type, binderDepth) || hasFreeMlttVariable(term.left, binderDepth) || hasFreeMlttVariable(term.right, binderDepth);
    case "refl":
      return hasFreeMlttVariable(term.type, binderDepth) || hasFreeMlttVariable(term.term, binderDepth);
    case "identity-elim":
      return hasFreeMlttVariable(term.type, binderDepth) || hasFreeMlttVariable(term.motive, binderDepth) ||
        hasFreeMlttVariable(term.reflexivityCase, binderDepth) || hasFreeMlttVariable(term.left, binderDepth) ||
        hasFreeMlttVariable(term.right, binderDepth) || hasFreeMlttVariable(term.equality, binderDepth);
    case "sigma":
    case "pi":
      return hasFreeMlttVariable(term.domain, binderDepth) || hasFreeMlttVariable(term.codomain, binderDepth + 1);
    case "pair":
      return hasFreeMlttVariable(term.sigmaType, binderDepth) || hasFreeMlttVariable(term.first, binderDepth) || hasFreeMlttVariable(term.second, binderDepth);
    case "first":
    case "second":
      return hasFreeMlttVariable(term.pair, binderDepth);
    case "lambda":
      return !!term.parameterType && hasFreeMlttVariable(term.parameterType, binderDepth) || hasFreeMlttVariable(term.body, binderDepth + 1);
    case "application":
      return hasFreeMlttVariable(term.functionTerm, binderDepth) || hasFreeMlttVariable(term.argument, binderDepth);
    case "annotation":
      return hasFreeMlttVariable(term.term, binderDepth) || hasFreeMlttVariable(term.type, binderDepth);
    case "external":
      return term.arguments.some(argument => hasFreeMlttVariable(argument, binderDepth)) || hasFreeMlttVariable(term.type, binderDepth);
  }
}

function shiftMlttTerm(term: MlttTerm, amount: number, cutoff = 0): MlttTerm {
  switch (term.kind) {
    case "universe":
    case "bool-type":
    case "true":
    case "false":
    case "nat-type":
    case "zero":
      return term;
    case "bool-elim":
      return mlttBoolElim(
        shiftMlttTerm(term.motive, amount, cutoff),
        shiftMlttTerm(term.trueCase, amount, cutoff),
        shiftMlttTerm(term.falseCase, amount, cutoff),
        shiftMlttTerm(term.scrutinee, amount, cutoff),
      );
    case "type-match":
      return mlttTypeMatch(
        shiftMlttTerm(term.scrutinee, amount, cutoff),
        term.cases.map(matchCase => {
          const captureCount = matchCase.captures?.length ?? 0;
          return {
            pattern: shiftMlttTerm(matchCase.pattern, amount, cutoff + captureCount),
            ...(matchCase.captures ? {
              captures: matchCase.captures.map(capture => ({ ...capture, type: shiftMlttTerm(capture.type, amount, cutoff) })),
            } : {}),
            result: shiftMlttTerm(matchCase.result, amount, cutoff + captureCount),
          };
        }),
        shiftMlttTerm(term.defaultCase, amount, cutoff),
      );
    case "successor":
      return mlttSuccessor(shiftMlttTerm(term.predecessor, amount, cutoff));
    case "nat-add":
      return mlttNatAdd(shiftMlttTerm(term.left, amount, cutoff), shiftMlttTerm(term.right, amount, cutoff));
    case "nat-elim":
      return mlttNatElim(
        shiftMlttTerm(term.motive, amount, cutoff),
        shiftMlttTerm(term.zeroCase, amount, cutoff),
        shiftMlttTerm(term.successorCase, amount, cutoff),
        shiftMlttTerm(term.scrutinee, amount, cutoff),
      );
    case "identity-type":
      return mlttIdentityType(
        shiftMlttTerm(term.type, amount, cutoff),
        shiftMlttTerm(term.left, amount, cutoff),
        shiftMlttTerm(term.right, amount, cutoff),
      );
    case "refl":
      return mlttRefl(shiftMlttTerm(term.type, amount, cutoff), shiftMlttTerm(term.term, amount, cutoff));
    case "identity-elim":
      return mlttIdentityElim(
        shiftMlttTerm(term.type, amount, cutoff),
        shiftMlttTerm(term.motive, amount, cutoff),
        shiftMlttTerm(term.reflexivityCase, amount, cutoff),
        shiftMlttTerm(term.left, amount, cutoff),
        shiftMlttTerm(term.right, amount, cutoff),
        shiftMlttTerm(term.equality, amount, cutoff),
      );
    case "sigma":
      return mlttSigma(term.parameterName, shiftMlttTerm(term.domain, amount, cutoff), shiftMlttTerm(term.codomain, amount, cutoff + 1));
    case "pair":
      return mlttPair(
        shiftMlttTerm(term.sigmaType, amount, cutoff),
        shiftMlttTerm(term.first, amount, cutoff),
        shiftMlttTerm(term.second, amount, cutoff),
      );
    case "first":
      return mlttFirst(shiftMlttTerm(term.pair, amount, cutoff));
    case "second":
      return mlttSecond(shiftMlttTerm(term.pair, amount, cutoff));
    case "variable":
      return term.index < cutoff ? term : mlttVariable(term.index + amount);
    case "pi":
      return mlttPi(term.parameterName, shiftMlttTerm(term.domain, amount, cutoff), shiftMlttTerm(term.codomain, amount, cutoff + 1));
    case "lambda":
      return mlttLambda(
        term.parameterName,
        shiftMlttTerm(term.body, amount, cutoff + 1),
        term.parameterType && shiftMlttTerm(term.parameterType, amount, cutoff),
      );
    case "application":
      return mlttApplication(shiftMlttTerm(term.functionTerm, amount, cutoff), shiftMlttTerm(term.argument, amount, cutoff));
    case "annotation":
      return mlttAnnotation(shiftMlttTerm(term.term, amount, cutoff), shiftMlttTerm(term.type, amount, cutoff));
    case "external":
      return mlttExternal(
        term.key,
        term.displayName,
        term.arguments.map(argument => shiftMlttTerm(argument, amount, cutoff)),
        shiftMlttTerm(term.type, amount, cutoff),
        term.identity,
      );
  }
}

function substituteMltt(term: MlttTerm, variableIndex: number, replacement: MlttTerm, binderDepth = 0): MlttTerm {
  switch (term.kind) {
    case "universe":
    case "bool-type":
    case "true":
    case "false":
    case "nat-type":
    case "zero":
      return term;
    case "bool-elim":
      return mlttBoolElim(
        substituteMltt(term.motive, variableIndex, replacement, binderDepth),
        substituteMltt(term.trueCase, variableIndex, replacement, binderDepth),
        substituteMltt(term.falseCase, variableIndex, replacement, binderDepth),
        substituteMltt(term.scrutinee, variableIndex, replacement, binderDepth),
      );
    case "type-match":
      return mlttTypeMatch(
        substituteMltt(term.scrutinee, variableIndex, replacement, binderDepth),
        term.cases.map(matchCase => {
          const captureCount = matchCase.captures?.length ?? 0;
          return {
            pattern: substituteMltt(matchCase.pattern, variableIndex, replacement, binderDepth + captureCount),
            ...(matchCase.captures ? {
              captures: matchCase.captures.map(capture => ({
                ...capture,
                type: substituteMltt(capture.type, variableIndex, replacement, binderDepth),
              })),
            } : {}),
            result: substituteMltt(matchCase.result, variableIndex, replacement, binderDepth + captureCount),
          };
        }),
        substituteMltt(term.defaultCase, variableIndex, replacement, binderDepth),
      );
    case "successor":
      return mlttSuccessor(substituteMltt(term.predecessor, variableIndex, replacement, binderDepth));
    case "nat-add":
      return mlttNatAdd(
        substituteMltt(term.left, variableIndex, replacement, binderDepth),
        substituteMltt(term.right, variableIndex, replacement, binderDepth),
      );
    case "nat-elim":
      return mlttNatElim(
        substituteMltt(term.motive, variableIndex, replacement, binderDepth),
        substituteMltt(term.zeroCase, variableIndex, replacement, binderDepth),
        substituteMltt(term.successorCase, variableIndex, replacement, binderDepth),
        substituteMltt(term.scrutinee, variableIndex, replacement, binderDepth),
      );
    case "identity-type":
      return mlttIdentityType(
        substituteMltt(term.type, variableIndex, replacement, binderDepth),
        substituteMltt(term.left, variableIndex, replacement, binderDepth),
        substituteMltt(term.right, variableIndex, replacement, binderDepth),
      );
    case "refl":
      return mlttRefl(
        substituteMltt(term.type, variableIndex, replacement, binderDepth),
        substituteMltt(term.term, variableIndex, replacement, binderDepth),
      );
    case "identity-elim":
      return mlttIdentityElim(
        substituteMltt(term.type, variableIndex, replacement, binderDepth),
        substituteMltt(term.motive, variableIndex, replacement, binderDepth),
        substituteMltt(term.reflexivityCase, variableIndex, replacement, binderDepth),
        substituteMltt(term.left, variableIndex, replacement, binderDepth),
        substituteMltt(term.right, variableIndex, replacement, binderDepth),
        substituteMltt(term.equality, variableIndex, replacement, binderDepth),
      );
    case "sigma":
      return mlttSigma(
        term.parameterName,
        substituteMltt(term.domain, variableIndex, replacement, binderDepth),
        substituteMltt(term.codomain, variableIndex, replacement, binderDepth + 1),
      );
    case "pair":
      return mlttPair(
        substituteMltt(term.sigmaType, variableIndex, replacement, binderDepth),
        substituteMltt(term.first, variableIndex, replacement, binderDepth),
        substituteMltt(term.second, variableIndex, replacement, binderDepth),
      );
    case "first":
      return mlttFirst(substituteMltt(term.pair, variableIndex, replacement, binderDepth));
    case "second":
      return mlttSecond(substituteMltt(term.pair, variableIndex, replacement, binderDepth));
    case "variable":
      return term.index === variableIndex + binderDepth ? shiftMlttTerm(replacement, binderDepth) : term;
    case "pi":
      return mlttPi(
        term.parameterName,
        substituteMltt(term.domain, variableIndex, replacement, binderDepth),
        substituteMltt(term.codomain, variableIndex, replacement, binderDepth + 1),
      );
    case "lambda":
      return mlttLambda(
        term.parameterName,
        substituteMltt(term.body, variableIndex, replacement, binderDepth + 1),
        term.parameterType && substituteMltt(term.parameterType, variableIndex, replacement, binderDepth),
      );
    case "application":
      return mlttApplication(
        substituteMltt(term.functionTerm, variableIndex, replacement, binderDepth),
        substituteMltt(term.argument, variableIndex, replacement, binderDepth),
      );
    case "annotation":
      return mlttAnnotation(
        substituteMltt(term.term, variableIndex, replacement, binderDepth),
        substituteMltt(term.type, variableIndex, replacement, binderDepth),
      );
    case "external":
      return mlttExternal(
        term.key,
        term.displayName,
        term.arguments.map(argument => substituteMltt(argument, variableIndex, replacement, binderDepth)),
        substituteMltt(term.type, variableIndex, replacement, binderDepth),
        term.identity,
      );
  }
}

function substituteMlttTop(replacement: MlttTerm, body: MlttTerm): MlttTerm {
  return shiftMlttTerm(substituteMltt(body, 0, shiftMlttTerm(replacement, 1)), -1);
}

function structurallyEqualMlttTerms(
  left: MlttTerm,
  right: MlttTerm,
  compareExternal?: MlttExternalEqualityComparer,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "universe":
      return left.level === (right as MlttUniverse).level;
    case "bool-type":
    case "true":
    case "false":
    case "nat-type":
    case "zero":
      return true;
    case "bool-elim": {
      const rightElim = right as MlttBoolElim;
      return structurallyEqualMlttTerms(left.motive, rightElim.motive, compareExternal) &&
        structurallyEqualMlttTerms(left.trueCase, rightElim.trueCase, compareExternal) &&
        structurallyEqualMlttTerms(left.falseCase, rightElim.falseCase, compareExternal) &&
        structurallyEqualMlttTerms(left.scrutinee, rightElim.scrutinee, compareExternal);
    }
    case "type-match": {
      const rightMatch = right as MlttTypeMatch;
      return left.cases.length === rightMatch.cases.length &&
        structurallyEqualMlttTerms(left.scrutinee, rightMatch.scrutinee, compareExternal) &&
        left.cases.every((matchCase, index) => {
          const rightCase = rightMatch.cases[index];
          const captures = matchCase.captures ?? [];
          const rightCaptures = rightCase.captures ?? [];
          return captures.length === rightCaptures.length &&
            captures.every((capture, captureIndex) => structurallyEqualMlttTerms(capture.type, rightCaptures[captureIndex].type, compareExternal)) &&
            structurallyEqualMlttTerms(matchCase.pattern, rightCase.pattern, compareExternal) &&
            structurallyEqualMlttTerms(matchCase.result, rightCase.result, compareExternal);
        }) &&
        structurallyEqualMlttTerms(left.defaultCase, rightMatch.defaultCase, compareExternal);
    }
    case "successor":
      return structurallyEqualMlttTerms(left.predecessor, (right as MlttSuccessor).predecessor, compareExternal);
    case "nat-add": {
      const rightAdd = right as MlttNatAdd;
      return structurallyEqualMlttTerms(left.left, rightAdd.left, compareExternal) && structurallyEqualMlttTerms(left.right, rightAdd.right, compareExternal);
    }
    case "nat-elim": {
      const rightElim = right as MlttNatElim;
      return structurallyEqualMlttTerms(left.motive, rightElim.motive, compareExternal) &&
        structurallyEqualMlttTerms(left.zeroCase, rightElim.zeroCase, compareExternal) &&
        structurallyEqualMlttTerms(left.successorCase, rightElim.successorCase, compareExternal) &&
        structurallyEqualMlttTerms(left.scrutinee, rightElim.scrutinee, compareExternal);
    }
    case "identity-type": {
      const rightIdentity = right as MlttIdentityType;
      return structurallyEqualMlttTerms(left.type, rightIdentity.type, compareExternal) &&
        structurallyEqualMlttTerms(left.left, rightIdentity.left, compareExternal) &&
        structurallyEqualMlttTerms(left.right, rightIdentity.right, compareExternal);
    }
    case "refl": {
      const rightRefl = right as MlttRefl;
      return structurallyEqualMlttTerms(left.type, rightRefl.type, compareExternal) &&
        structurallyEqualMlttTerms(left.term, rightRefl.term, compareExternal);
    }
    case "identity-elim": {
      const rightElim = right as MlttIdentityElim;
      return structurallyEqualMlttTerms(left.type, rightElim.type, compareExternal) &&
        structurallyEqualMlttTerms(left.motive, rightElim.motive, compareExternal) &&
        structurallyEqualMlttTerms(left.reflexivityCase, rightElim.reflexivityCase, compareExternal) &&
        structurallyEqualMlttTerms(left.left, rightElim.left, compareExternal) &&
        structurallyEqualMlttTerms(left.right, rightElim.right, compareExternal) &&
        structurallyEqualMlttTerms(left.equality, rightElim.equality, compareExternal);
    }
    case "sigma": {
      const rightSigma = right as MlttSigma;
      return structurallyEqualMlttTerms(left.domain, rightSigma.domain, compareExternal) &&
        structurallyEqualMlttTerms(left.codomain, rightSigma.codomain, compareExternal);
    }
    case "pair": {
      const rightPair = right as MlttPair;
      return structurallyEqualMlttTerms(left.sigmaType, rightPair.sigmaType, compareExternal) &&
        structurallyEqualMlttTerms(left.first, rightPair.first, compareExternal) &&
        structurallyEqualMlttTerms(left.second, rightPair.second, compareExternal);
    }
    case "first":
      return structurallyEqualMlttTerms(left.pair, (right as MlttFirst).pair, compareExternal);
    case "second":
      return structurallyEqualMlttTerms(left.pair, (right as MlttSecond).pair, compareExternal);
    case "variable":
      return left.index === (right as MlttVariable).index;
    case "pi": {
      const rightPi = right as MlttPi;
      return structurallyEqualMlttTerms(left.domain, rightPi.domain, compareExternal) && structurallyEqualMlttTerms(left.codomain, rightPi.codomain, compareExternal);
    }
    case "lambda":
      return structurallyEqualMlttTerms(left.body, (right as MlttLambda).body, compareExternal);
    case "application": {
      const rightApplication = right as MlttApplication;
      return structurallyEqualMlttTerms(left.functionTerm, rightApplication.functionTerm, compareExternal) && structurallyEqualMlttTerms(left.argument, rightApplication.argument, compareExternal);
    }
    case "annotation": {
      const rightAnnotation = right as MlttAnnotation;
      return structurallyEqualMlttTerms(left.term, rightAnnotation.term, compareExternal) && structurallyEqualMlttTerms(left.type, rightAnnotation.type, compareExternal);
    }
    case "external": {
      const rightExternal = right as MlttExternal;
      return left.arguments.length === rightExternal.arguments.length &&
        left.arguments.every((argument, index) => structurallyEqualMlttTerms(argument, rightExternal.arguments[index], compareExternal)) &&
        structurallyEqualMlttTerms(left.type, rightExternal.type, compareExternal) &&
        (compareExternal ? compareExternal(left, rightExternal) : left.key === rightExternal.key);
    }
  }
}

function printMlttTermWorker(term: MlttTerm, names: readonly string[]): string {
  switch (term.kind) {
    case "universe":
      return `Type${term.level}`;
    case "bool-type":
      return "Bool";
    case "true":
      return "True";
    case "false":
      return "False";
    case "bool-elim":
      return `BoolElim<${printMlttTermWorker(term.motive, names)}, ${printMlttTermWorker(term.trueCase, names)}, ${printMlttTermWorker(term.falseCase, names)}, ${printMlttTermWorker(term.scrutinee, names)}>`;
    case "type-match":
      return `TypeMatch<${printMlttTermWorker(term.scrutinee, names)}, ${
        term.cases.map(matchCase => {
          const captureNames = (matchCase.captures ?? []).map(capture => capture.name);
          return `Case<${printMlttTermWorker(matchCase.pattern, [...captureNames, ...names])}, ${printMlttTermWorker(matchCase.result, [...captureNames, ...names])}>`;
        }).join(", ")
      }, Default<${printMlttTermWorker(term.defaultCase, names)}>>`;
    case "nat-type":
      return "Nat";
    case "zero":
      return "Zero";
    case "successor":
      return `Succ<${printMlttTermWorker(term.predecessor, names)}>`;
    case "nat-add":
      return `NatAdd<${printMlttTermWorker(term.left, names)}, ${printMlttTermWorker(term.right, names)}>`;
    case "nat-elim":
      return `NatElim<${printMlttTermWorker(term.motive, names)}, ${printMlttTermWorker(term.zeroCase, names)}, ${printMlttTermWorker(term.successorCase, names)}, ${printMlttTermWorker(term.scrutinee, names)}>`;
    case "identity-type":
      return `Eq<${printMlttTermWorker(term.type, names)}, ${printMlttTermWorker(term.left, names)}, ${printMlttTermWorker(term.right, names)}>`;
    case "refl":
      return `Refl<${printMlttTermWorker(term.type, names)}, ${printMlttTermWorker(term.term, names)}>`;
    case "identity-elim":
      return `J<${printMlttTermWorker(term.type, names)}, ${printMlttTermWorker(term.motive, names)}, ${printMlttTermWorker(term.reflexivityCase, names)}, ${printMlttTermWorker(term.left, names)}, ${printMlttTermWorker(term.right, names)}, ${printMlttTermWorker(term.equality, names)}>`;
    case "sigma": {
      const name = freshName(term.parameterName, names);
      return `Sigma<(${name}: ${printMlttTermWorker(term.domain, names)}) -> ${printMlttTermWorker(term.codomain, [name, ...names])}>`;
    }
    case "pair":
      return `Pair<${printMlttTermWorker(term.sigmaType, names)}, ${printMlttTermWorker(term.first, names)}, ${printMlttTermWorker(term.second, names)}>`;
    case "first":
      return `First<${printMlttTermWorker(term.pair, names)}>`;
    case "second":
      return `Second<${printMlttTermWorker(term.pair, names)}>`;
    case "variable":
      return names[term.index] ?? `#${term.index}`;
    case "pi": {
      const name = freshName(term.parameterName, names);
      return `(Pi (${name}: ${printMlttTermWorker(term.domain, names)}). ${printMlttTermWorker(term.codomain, [name, ...names])})`;
    }
    case "lambda": {
      const name = freshName(term.parameterName, names);
      return `(lambda ${name}. ${printMlttTermWorker(term.body, [name, ...names])})`;
    }
    case "application":
      return `(${printMlttTermWorker(term.functionTerm, names)} ${printMlttTermWorker(term.argument, names)})`;
    case "annotation":
      return `(${printMlttTermWorker(term.term, names)} : ${printMlttTermWorker(term.type, names)})`;
    case "external":
      return term.displayName;
  }
}

function freshName(preferredName: string, names: readonly string[]): string {
  const base = preferredName || "x";
  if (!names.includes(base)) return base;
  let suffix = 1;
  while (names.includes(`${base}${suffix}`)) suffix++;
  return `${base}${suffix}`;
}



