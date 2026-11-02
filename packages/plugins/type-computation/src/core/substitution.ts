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
} from "./terms";

export function hasFreeMlttVariable(term: MlttTerm, binderDepth = 0): boolean {
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

export function shiftMlttTerm(term: MlttTerm, amount: number, cutoff = 0): MlttTerm {
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

export function substituteMlttTop(replacement: MlttTerm, body: MlttTerm): MlttTerm {
  return shiftMlttTerm(substituteMltt(body, 0, shiftMlttTerm(replacement, 1)), -1);
}


