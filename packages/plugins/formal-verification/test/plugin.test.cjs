const assert = require("node:assert/strict");
const test = require("node:test");
const { formalVerificationAnalyzer } = require("../dist");

const labeled = (text, start = 0) => ({ kind: 256, start, end: start + text.length, text, children: [] });
const input = nodes => ({
  currentDirectory: process.cwd(),
  rootFileNames: ["proof.tspp"],
  syntaxKinds: { sourceFile: 308, labeledStatement: 256 },
  sourceFiles: [{
    fileName: "proof.tspp",
    text: nodes.map(node => node.text).join("\n"),
    root: { kind: 308, start: 0, end: 100, text: "", children: nodes },
  }],
});

test("proves and rejects arithmetic assertions through Z3", async () => {
  const diagnostics = await formalVerificationAnalyzer.analyze(input([
    labeled("assert: 1n + 1n === 2n;"),
    labeled("assert: 2 * 3 < 5;", 30),
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
    syntaxKinds: { sourceFile: 308, labeledStatement: 256 },
    sourceFiles: [{ fileName: "contract.tspp", text: source, root: { kind: 308, start: 0, end: source.length, text: source, children: [] } }],
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
    syntaxKinds: { sourceFile: 308, labeledStatement: 256 },
    sourceFiles: [{ fileName: "loop.tspp", text: source, root: { kind: 308, start: 0, end: source.length, text: source, children: [] } }],
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
    currentDirectory: process.cwd(), rootFileNames: ["branches.tspp"], syntaxKinds: {},
    sourceFiles: [{ fileName: "branches.tspp", text: source, root: {} }],
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
    currentDirectory: process.cwd(), rootFileNames: ["local.tspp"], syntaxKinds: {},
    sourceFiles: [{ fileName: "local.tspp", text: source, root: {} }],
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
    currentDirectory: process.cwd(), rootFileNames: ["calls.tspp"], syntaxKinds: {},
    sourceFiles: [{ fileName: "calls.tspp", text: source, root: {} }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /call precondition could not be proved/);
});

test("models JavaScript bigint division and remainder toward zero", async () => {
  const source = `assert: -7n / 2n === -3n;
  assert: -7n % 2n === -1n;`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["arithmetic.tspp"], syntaxKinds: {},
    sourceFiles: [{ fileName: "arithmetic.tspp", text: source, root: {} }],
  });
  assert.deepEqual(diagnostics, []);
});

test("requires runtime divisors to be nonzero", async () => {
  const source = `function divide(value: bigint, divisor: bigint): bigint {
    return value / divisor;
  }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["definedness.tspp"], syntaxKinds: {},
    sourceFiles: [{ fileName: "definedness.tspp", text: source, root: {} }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /division definedness could not be proved/);
});

test("proves refinement introductions and propagates parameter predicates", async () => {
  const source = `type Positive = bigint with { predicate: value > 0n; };
  type NonNegative = bigint with { predicate: value >= 0n; };
  const age: Positive = 18n;
  function widen(value: Positive): NonNegative { return value; }`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["refinement.tspp"], syntaxKinds: {},
    sourceFiles: [{ fileName: "refinement.tspp", text: source, root: {} }],
  });
  assert.deepEqual(diagnostics, []);
});

test("rejects an invalid refinement introduction", async () => {
  const source = `type Positive = bigint with { predicate: value > 0n; };
  const invalid: Positive = -1n;`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["bad-refinement.tspp"], syntaxKinds: {},
    sourceFiles: [{ fileName: "bad-refinement.tspp", text: source, root: {} }],
  });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /refinement introduction could not be proved/);
});
