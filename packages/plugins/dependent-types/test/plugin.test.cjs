const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dependentTypesPlugin,
  dependentTypesAnalyzer,
  parseDependentType,
  projectDependentTypes,
  restoreDependentTypeAlias,
} = require("../dist");
const mltt = require("../dist/core/index.js");

function input(text) {
  return {
    currentDirectory: process.cwd(),
    rootFileNames: ["types.tspp"],
    syntaxKinds: { sourceFile: 0, labeledStatement: 0 },
    sourceFiles: [{
      fileName: "types.tspp",
      text,
      root: { kind: 0, start: 0, end: text.length, text, children: [] },
    }],
  };
}

test("parses and checks a genuinely dependent identity type", () => {
  const term = parseDependentType("{A: Type0} -> (value: A) -> A");
  assert.equal(term.kind, "pi");
  assert.deepEqual(mltt.inferMlttType(term), mltt.mlttUniverse(1));
});

test("keeps ordinary TypeScript generic types behind the external-term boundary", () => {
  const term = parseDependentType("(items: Array<string>) -> Array<string>");
  assert.deepEqual(mltt.inferMlttType(term), mltt.mlttUniverse(0));
  assert.equal(term.domain.kind, "external");
  assert.equal(term.domain.key, "Array");
  assert.equal(term.domain.arguments[0].displayName, "string");
});

test("projects plugin-owned syntax to length-preserving TypeScript", () => {
  const source = "export type Identity: Type1 = {A: Type0} -> (value: A) -> A;\n";
  const projected = projectDependentTypes("identity.tspp", source);
  assert.equal(projected.length, source.length);
  assert.equal(projected.split("\n").length, source.split("\n").length);
  assert.match(projected, /type Identity\s+= <A>\(value:A\)=>A\s+;/);
});

test("projects erased binders and partial inference through ordinary TypeScript", () => {
  const source = `
    export type Select: Type1 = {A: Type0} -> (left: A) -> {B: Type0} -> (right: B) -> B;
    declare const select: Select;
    select<auto, string>(1, "right");
  `;
  const projected = projectDependentTypes("select.tspp", source);
  assert.equal(projected.length, source.length);
  assert.match(projected, /type Select\s+= <A,B>\(left:A,right:B\)=>B/);
  assert.doesNotMatch(projected, /auto/);
});

test("restores authored dependent aliases for feature-rich declarations", () => {
  const source = `
    export type UniverseZero: Type1 = Type0;
    export type ElementOrSelf: Type1 = (A: Type0) -> match mltt A {
      Array<infer Element>: Element,
      _: A
    };
  `;
  assert.deepEqual(restoreDependentTypeAlias({
    fileName: "types.tspp",
    sourceText: source,
    name: "UniverseZero",
    declarationStart: source.indexOf("type UniverseZero"),
  }), { annotation: "Type1", type: "Type0" });
  assert.deepEqual(restoreDependentTypeAlias({
    fileName: "types.tspp",
    sourceText: source,
    name: "ElementOrSelf",
    declarationStart: source.indexOf("type ElementOrSelf"),
  }), {
    annotation: "Type1",
    type: "(A: Type0) -> match mltt A {\n      Array<infer Element>: Element,\n      _: A\n    }",
  });
});

test("analyzer accepts valid aliases and resolves earlier aliases", async () => {
  const diagnostics = await dependentTypesAnalyzer.analyze(input(`
    export type U: Type1 = Type0;
    export type Identity: Type1 = {A: Type0} -> (value: A) -> A;
    export type Alias: Type1 = Identity;
  `));
  assert.deepEqual(diagnostics, []);
  assert.equal(diagnostics.artifacts.length, 3);
  assert.equal(diagnostics.artifacts[1].kind, "dependent-types/normal-form");
  assert.equal(diagnostics.artifacts[1].language, "plaintext");
  assert.match(diagnostics.artifacts[1].content, /Identity : Type1/);
  assert.match(diagnostics.artifacts[1].content, /Identity = \(Pi/);
});

test("publishes normalized terms and their normalized MLTT types", async () => {
  const diagnostics = await dependentTypesAnalyzer.analyze(input(`
    export type One: Nat = NatAdd<Zero, Succ<Zero>>;
    export type Proof: Type0 = Eq<Nat, One, Succ<Zero>>;
  `));
  assert.deepEqual(diagnostics, []);
  assert.equal(diagnostics.artifacts.length, 2);
  assert.match(diagnostics.artifacts[0].content, /One : Nat/);
  assert.match(diagnostics.artifacts[0].content, /One = Succ<Zero>/);
  assert.match(diagnostics.artifacts[1].content, /Eq<Nat, Succ<Zero>, Succ<Zero>>/);
});

test("analyzer reports kind mismatches and ill-typed core terms", async () => {
  const diagnostics = await dependentTypesAnalyzer.analyze(input(`
    export type WrongUniverse: Type0 = Type0;
    export type BadSuccessor: Type0 = Succ<Type0>;
  `));
  assert.equal(diagnostics.length, 2);
  assert.match(diagnostics[0].message, /Type1, not Type0/);
  assert.match(diagnostics[1].message, /Expected Nat/);
});

test("parses and normalizes all built-in eliminators", () => {
  const trueResult = parseDependentType(
    "If<True, Ann<Lam<(ignored: Bool) -> Type0>, (ignored: Bool) -> Type1>, string, number>",
  );
  assert.equal(mltt.normalizeMlttTerm(trueResult).displayName, "string");

  const sum = parseDependentType("NatAdd<Succ<Zero>, Succ<Zero>>");
  assert.deepEqual(
    mltt.normalizeMlttTerm(sum),
    mltt.mlttSuccessor(mltt.mlttSuccessor(mltt.mlttZero())),
  );

  const pair = parseDependentType(
    "Pair<Sigma<(value: Nat) -> Eq<Nat, value, Zero>>, Zero, Refl<Nat, Zero>>",
  );
  assert.deepEqual(mltt.normalizeMlttTerm(mltt.mlttFirst(pair)), mltt.mlttZero());
  assert.equal(mltt.normalizeMlttTerm(mltt.mlttSecond(pair)).kind, "refl");
});

test("parses ordered type matching with generic captures", () => {
  const term = parseDependentType(
    "match mltt Array<string> { Array<infer Element>: Element, _: never }",
  );
  assert.equal(term.kind, "type-match");
  assert.equal(term.cases.length, 1);
  assert.equal(term.cases[0].captures[0].name, "Element");
  assert.equal(term.cases[0].result.kind, "variable");
});

test("checks aliases annotated by terms as well as universes", async () => {
  const diagnostics = await dependentTypesAnalyzer.analyze(input(`
    export type One: Nat = Succ<Zero>;
    export type Two: Nat = NatAdd<One, One>;
    export type Proof: Type0 = Eq<Nat, Two, Succ<Succ<Zero>>>;
  `));
  assert.deepEqual(diagnostics, []);
});

test("registers type projection, analysis, reification, and matching as one capsule", () => {
  const registrations = [];
  const compiler = {
    expressionSyntaxKinds: { identifier: 1 },
    registerExpressionSyntax(syntax) { registrations.push(["expression", syntax]); return () => {}; },
    registerSourcePreprocessor(preprocessor) { registrations.push(["projection", preprocessor]); return () => {}; },
    registerProgramAnalyzer(analyzer) { registrations.push(["analysis", analyzer]); return () => {}; },
  };
  const dispose = dependentTypesPlugin.facets.compiler.activate({ compiler });
  assert.equal(registrations.filter(([kind]) => kind === "expression").length, 2);
  assert.deepEqual(registrations.map(([kind]) => kind), ["expression", "expression", "projection", "analysis"]);
  dispose();
});

