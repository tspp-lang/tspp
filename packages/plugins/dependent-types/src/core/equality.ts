import type {
  MlttAnnotation,
  MlttApplication,
  MlttBoolElim,
  MlttExternalEqualityComparer,
  MlttExternal,
  MlttFirst,
  MlttIdentityElim,
  MlttIdentityType,
  MlttLambda,
  MlttNatAdd,
  MlttNatElim,
  MlttPair,
  MlttPi,
  MlttRefl,
  MlttSecond,
  MlttSigma,
  MlttSuccessor,
  MlttTerm,
  MlttTypeMatch,
  MlttUniverse,
  MlttVariable,
} from "./terms";

export function structurallyEqualMlttTerms(
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


