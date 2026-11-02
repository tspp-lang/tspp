
const assert = require("node:assert/strict");
const test = require("node:test");
const mltt = require("../dist/core/index.js");

const type0 = mltt.mlttUniverse(0);

test("universes inhabit their successors", () => {
  assert.deepEqual(mltt.inferMlttType(type0), mltt.mlttUniverse(1));
  assert.deepEqual(mltt.inferMlttType(mltt.mlttUniverse(4)), mltt.mlttUniverse(5));
});

test("dependent polymorphic identity checks and beta-reduces", () => {
  const identityType = mltt.mlttPi(
    "A",
    type0,
    mltt.mlttPi("value", mltt.mlttVariable(0), mltt.mlttVariable(1)),
  );
  const identity = mltt.mlttLambda(
    "A",
    mltt.mlttLambda("value", mltt.mlttVariable(0)),
  );

  mltt.checkMlttType(identity, identityType);
  const application = mltt.mlttApplication(
    mltt.mlttApplication(
      mltt.mlttAnnotation(identity, identityType),
      mltt.mlttNatType(),
    ),
    mltt.mlttZero(),
  );
  assert.deepEqual(mltt.normalizeMlttTerm(application), mltt.mlttZero());
});

test("Nat addition and Bool elimination compute", () => {
  const one = mltt.mlttSuccessor(mltt.mlttZero());
  const two = mltt.mlttSuccessor(one);
  const three = mltt.mlttSuccessor(two);
  assert.deepEqual(mltt.normalizeMlttTerm(mltt.mlttNatAdd(one, two)), three);

  const bool = mltt.mlttBoolType();
  const motive = mltt.mlttAnnotation(
    mltt.mlttLambda("value", mltt.mlttNatType()),
    mltt.mlttPi("value", bool, type0),
  );
  const eliminated = mltt.mlttBoolElim(
    motive,
    one,
    two,
    mltt.mlttFalse(),
  );
  assert.deepEqual(mltt.normalizeMlttTerm(eliminated), two);
});

test("identity and dependent-pair eliminations compute", () => {
  const equality = mltt.mlttIdentityType(
    mltt.mlttNatType(),
    mltt.mlttZero(),
    mltt.mlttZero(),
  );
  const proof = mltt.mlttRefl(mltt.mlttNatType(), mltt.mlttZero());
  mltt.checkMlttType(proof, equality);

  const sigma = mltt.mlttSigma(
    "n",
    mltt.mlttNatType(),
    mltt.mlttIdentityType(
      mltt.mlttNatType(),
      mltt.mlttVariable(0),
      mltt.mlttVariable(0),
    ),
  );
  const pair = mltt.mlttPair(sigma, mltt.mlttZero(), proof);
  assert.deepEqual(mltt.normalizeMlttTerm(mltt.mlttFirst(pair)), mltt.mlttZero());
  assert.deepEqual(mltt.normalizeMlttTerm(mltt.mlttSecond(pair)), proof);
});

test("external terms keep host interoperability behind callbacks", () => {
  const stringType = mltt.mlttExternal("string", "string", [], type0);
  const arrayOfString = mltt.mlttExternal("Array<string>", "Array<string>", [], type0);
  const arrayPattern = mltt.mlttExternal(
    "Array<$0>",
    "Array<infer T>",
    [mltt.mlttVariable(0)],
    type0,
  );
  const match = mltt.mlttTypeMatch(
    arrayOfString,
    [{
      pattern: arrayPattern,
      captures: [{ name: "T", type: type0 }],
      result: mltt.mlttVariable(0),
    }],
    mltt.mlttBoolType(),
  );

  assert.deepEqual(
    mltt.normalizeMlttTerm(
      match,
      undefined,
      () => ({ kind: "matched", captures: [stringType] }),
    ),
    stringType,
  );
});

test("ill-typed terms fail inside the isolated kernel", () => {
  assert.throws(
    () => mltt.inferMlttType(mltt.mlttSuccessor(type0)),
    error => error instanceof mltt.MlttTypeError && error.code === "type-mismatch",
  );
});



