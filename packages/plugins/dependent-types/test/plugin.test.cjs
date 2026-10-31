const assert = require("node:assert/strict");
const test = require("node:test");
const {
  dependentTypesAnalyzer,
  parseDependentType,
  projectDependentTypes,
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
  assert.match(projected, /type Identity\s+= any\s+;/);
});

test("analyzer accepts valid aliases and resolves earlier aliases", async () => {
  const diagnostics = await dependentTypesAnalyzer.analyze(input(`
    export type U: Type1 = Type0;
    export type Identity: Type1 = {A: Type0} -> (value: A) -> A;
    export type Alias: Type1 = Identity;
  `));
  assert.deepEqual(diagnostics, []);
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

