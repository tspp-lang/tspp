import {
  MlttContext,
  MlttExternalEqualityComparer,
  MlttExternalPatternMatcher,
  MlttTerm,
  MlttTypeError,
  mlttAnnotation,
  mlttApplication,
  mlttBoolElim,
  mlttBoolType,
  mlttExternal,
  mlttFalse,
  mlttFirst,
  mlttIdentityElim,
  mlttIdentityType,
  mlttLambda,
  mlttNatAdd,
  mlttNatElim,
  mlttNatType,
  mlttPair,
  mlttPi,
  mlttRefl,
  mlttSecond,
  mlttSigma,
  mlttSuccessor,
  mlttTrue,
  mlttTypeMatch,
  mlttUniverse,
  mlttVariable,
  mlttZero,
  type MlttDefinitionalComparison,
} from "./terms";
import { structurallyEqualMlttTerms } from "./equality";
import { hasFreeMlttVariable, substituteMlttTop } from "./substitution";

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


