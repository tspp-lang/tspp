const assert = require("node:assert/strict");
const test = require("node:test");
const { createProgram, usePlugins } = require("../../test-support/compile.cjs");
const { createFormalVerificationAnalyzer, formalVerificationAnalyzer, formalVerificationPlugin } = require("../dist");
const { restoreContractFunctionClause } = require("../dist/contracts");
const { restoreRefinementTypeAlias } = require("../dist/refinements");
const { clearPreparedVerificationSources, prepareVerificationSource } = require("../dist/source-cache");

usePlugins(formalVerificationPlugin);

const labeled = text => ({ text });
const input = nodes => ({
  currentDirectory: process.cwd(),
  rootFileNames: ["proof.tspp"],
  sourceFiles: [{ fileName: "proof.tspp", text: nodes.map(node => node.text).join("\n") }],
});

test("reuses prepared source models until the source text changes", () => {
  clearPreparedVerificationSources();
  const source = input([labeled("assert: true;")]).sourceFiles[0];
  const first = prepareVerificationSource(source);
  assert.strictEqual(prepareVerificationSource(source), first);
  assert.notStrictEqual(prepareVerificationSource({ ...source, text: "assert: false;" }), first);
});

test("restores contracts and refinements for feature-rich declarations", () => {
  const source = `type Positive = bigint with { predicate: value > 0n; };
  function widen(value: Positive) with {
    requires: value > 0n;
    ensures: result >= value;
  }: bigint { return value; }`;
  assert.deepEqual(restoreRefinementTypeAlias({
    fileName: "proof.tspp",
    sourceText: source,
    name: "Positive",
    declarationStart: source.indexOf("type Positive"),
  }), { type: "bigint with { predicate: value > 0n; }" });
  assert.equal(restoreContractFunctionClause({
    fileName: "proof.tspp",
    sourceText: source,
    name: "widen",
    declarationStart: source.indexOf("function widen"),
  }), "with {\n    requires: value > 0n;\n    ensures: result >= value;\n  }");
});

test("proves and rejects arithmetic assertions through Z3", async () => {
  const diagnostics = await formalVerificationAnalyzer.analyze(input([
    labeled("assert: 1n + 1n === 2n;"),
    labeled("assert: 2 * 3 < 5;"),
  ]));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 19002);
  assert.match(diagnostics[0].message, /could not be proved/);
});

test("verifies symbolic function postconditions", async () => {
  const source = `function increment(value: bigint) with {
    requires: value >= 0n;
    ensures: result > value;
  }: bigint { return value + 1n; }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(),
    rootFileNames: ["contract.tspp"],
    sourceFiles: [{ fileName: "contract.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("verifies loop invariant initialization and preservation", async () => {
  const source = `function count(limit: bigint) with {
    requires: limit >= 0n;
    ensures: result === limit;
  }: bigint {
    let current: bigint = 0n;
    while (current < limit) with {
      invariant: current >= 0n && current <= limit;
    } {
      current += 1n;
    }
    return current;
  }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["loop.tspp"],
    sourceFiles: [{ fileName: "loop.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("tracks branch facts across every return path", async () => {
  const source = `function absolute(value: bigint) with {
    ensures: result >= 0n;
  }: bigint {
    if (value >= 0n) return value;
    return -value;
  }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["branches.tspp"],
    sourceFiles: [{ fileName: "branches.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("uses trusted assumptions and local symbolic values for assertions", async () => {
  const source = `function increment(value: bigint): bigint {
    assume: value >= 0n;
    const next = value + 1n;
    assert: next > 0n;
    return next;
  }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["local.tspp"],
    sourceFiles: [{ fileName: "local.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("checks direct call preconditions and consumes verified summaries", async () => {
  const source = `function successor(value: bigint) with {
    requires: [value >= 0n, value < 10n];
    ensures: result === value + 1n;
  }: bigint { return value + 1n; }
  function twice(value: bigint) with {
    requires: value >= 0n && value < 9n;
    ensures: result === value + 2n;
  }: bigint { return successor(successor(value)); }
  successor(-1n);`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["calls.tspp"],
    sourceFiles: [{ fileName: "calls.tspp", text: source }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /call precondition could not be proved/);
});

test("models JavaScript bigint division and remainder toward zero", async () => {
  const source = `assert: -7n / 2n === -3n;
  assert: -7n % 2n === -1n;`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["arithmetic.tspp"],
    sourceFiles: [{ fileName: "arithmetic.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("requires runtime divisors to be nonzero", async () => {
  const source = `function divide(value: bigint, divisor: bigint) with { ensures: true; }: bigint {
    return value / divisor;
  }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["definedness.tspp"],
    sourceFiles: [{ fileName: "definedness.tspp", text: source }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /division definedness could not be proved/);
});

test("a proof directive is a statement", () => {
  const members = `export interface I { assert: boolean; assume: number; }
  export type T = { assert: string; };
  export const i: I = { assert: true, assume: 1 };`;
  assert.deepEqual(createProgram(members).program.getSemanticDiagnostics(), []);
  const erased = createProgram("export function f(v: bigint) { assert: v === v; assume: v > 0n; return v; }\nassert: 1n === 1n;");
  erased.program.emit();
  assert.doesNotMatch(erased.outputs.get("/main.js"), /assert|assume/);
});

test("proves refinement introductions and propagates parameter predicates", async () => {
  const source = `type Positive = bigint with { predicate: value > 0n; };
  type NonNegative = bigint with { predicate: value >= 0n; };
  const age: Positive = 18n;
  function widen(value: Positive): NonNegative { return value; }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["refinement.tspp"],
    sourceFiles: [{ fileName: "refinement.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("rejects an invalid refinement introduction", async () => {
  const source = `type Positive = bigint with { predicate: value > 0n; };
  const invalid: Positive = -1n;`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["bad-refinement.tspp"],
    sourceFiles: [{ fileName: "bad-refinement.tspp", text: source }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /refinement introduction could not be proved/);
});

test("verifies number arithmetic under an explicit mathematical-real model", async () => {
  const source = `function scaledSum(left: number, right: number) with {
    numberModel: "mathematical-real";
    ensures: result === (left + right) * 0.5;
  }: number { return (left + right) * 0.5; }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["real.tspp"],
    sourceFiles: [{ fileName: "real.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("requires an explicit model for number proofs", async () => {
  const source = `function increment(value: number) with {
    ensures: result > value;
  }: number { return value + 1; }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["number.tspp"],
    sourceFiles: [{ fileName: "number.tspp", text: source }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /requires numberModel/);
});

test("emits safe-integer overflow obligations", async () => {
  const source = `function double(value: number) with {
    numberModel: "safe-integer";
  }: number { return value * 2; }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["safe.tspp"],
    sourceFiles: [{ fileName: "safe.tspp", text: source }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /safe-integer range could not be proved/);
});

test("supports string equality without treating strings as arithmetic", async () => {
  const source = `function status() with {
    ensures: result === "ok";
  }: string { return "ok"; }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["strings.tspp"],
    sourceFiles: [{ fileName: "strings.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("uses branch facts for record fields and discriminated unions", async () => {
  const source = `type ParseResult =
    | { _tag: "Parsed"; value: bigint }
    | { _tag: "Rejected"; code: string };
  function magnitude(input: ParseResult) with {
    ensures: result >= 0n;
  }: bigint {
    if (input._tag === "Parsed") {
      if (input.value >= 0n) return input.value;
      return -input.value;
    }
    return 0n;
  }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["records.tspp"],
    sourceFiles: [{ fileName: "records.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("publishes replayable SMT-LIB as generic analysis artifacts", async () => {
  const source = `assert: 1n + 1n === 2n;`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["artifact.tspp"],
    sourceFiles: [{ fileName: "artifact.tspp", text: source }],
  });
  assert.equal(diagnostics.artifacts.length, 1);
  assert.equal(diagnostics.artifacts[0].status, "proved");
  assert.match(diagnostics.artifacts[0].content, /\(check-sat\)/);
  assert.match(diagnostics.artifacts[0].content, /tspp\.js\.trunc\.div/);
});

test("encodes recursive data constructors and switch paths", async () => {
  const source = `data BigIntList = End | Link(head: bigint, tail: BigIntList);
  function singleton(value: bigint) with {
    ensures: result._tag === "Link";
  }: BigIntList { return Link(value, End); }
  function headOrZero(input: BigIntList) with {
    requires: input._tag !== "Link" || input.head >= 0n;
    ensures: result >= 0n;
  }: bigint {
    switch (input._tag) {
      case "Link": return input.head;
      case "End": return 0n;
    }
  }`;
  // Data types reach the verifier through the nominal-types ADT API.
  const { nominalTypesADTAPI } = require("../../nominal-types/dist");
  const diagnostics = await createFormalVerificationAnalyzer({ getNominalTypes: () => nominalTypesADTAPI }).analyze({
    currentDirectory: process.cwd(), rootFileNames: ["data.tspp"],
    sourceFiles: [{ fileName: "data.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
});

test("loads reusable predicates, quantifiers, axioms, and recursive definitions", async () => {
  const source = `import * as smt from "@tspp/plugin-formal-verification/smt";
  const shiftedNonnegative = smt.definePredicate(
    [["offset", smt.Int]],
    offset => smt.forall([["value", smt.Int]], value =>
      smt.implies(smt.ge(value, 0n), smt.ge(smt.add(value, offset), offset))),
  );
  const triangular = smt.defineRecursiveFunction(
    [["value", smt.Int]], smt.Int,
    value => smt.ite(smt.le(value, 0n), 0n, smt.add(value, triangular(smt.sub(value, 1n)))),
  );
  const absolute = smt.defineFunction(
    [["value", smt.Int]], smt.Int,
    value => smt.ite(smt.ge(value, 0n), value, smt.sub(0n, value)),
  );
  const hasIdentityWitness = smt.definePredicate(
    [["target", smt.Int]],
    target => smt.exists([["witness", smt.Int]], witness => smt.eq(witness, target)),
  );
  const successor = smt.declareFunction([smt.Int], smt.Int);
  smt.axiom([["value", smt.Int]], value => smt.eq(successor(value), smt.add(value, 1n)));
  assert: shiftedNonnegative(5n);
  assert: triangular(4n) === 10n;
  assert: absolute(-4n) === 4n;
  assert: hasIdentityWitness(7n);
  assert: successor(2n) === 3n;`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["logic.tspp"],
    sourceFiles: [{ fileName: "logic.tspp", text: source }],
  });
  assert.deepEqual(diagnostics, []);
  assert.match(diagnostics.artifacts[0].content, /define-fun \|shiftedNonnegative\|/);
  assert.match(diagnostics.artifacts[0].content, /forall/);
  assert.match(diagnostics.artifacts[0].content, /define-fun-rec \|triangular\|/);
  assert.match(diagnostics.artifacts[0].content, /exists/);
  assert.match(diagnostics.artifacts[0].content, /trusted axiom/);
});

test("keeps logic declarations static-only at runtime", () => {
  const smt = require("../dist/smt");
  const predicate = smt.definePredicate([["value", smt.Int]], value => smt.ge(value, 0n));
  assert.throws(() => predicate(1n), /exists only during static verification/);
});
