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
import {
  areMlttTermsDefinitionallyEqual,
  weakHeadNormalizeMltt,
} from "./normalize";
import { printMlttTerm } from "./printing";
import { shiftMlttTerm, substituteMlttTop } from "./substitution";

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


