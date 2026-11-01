// Mutation tests: each case breaks one verified example in a way that makes its contract false at runtime, and the
// verifier must reject the result. A verifier that silently stops modeling some construct still passes every
// "verifies" test, so this guards the soundness fixes from the other direction. Mutations are chosen by hand to
// avoid equivalent mutants, changes that leave the program correct.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { analyzeSource } = require("./analyze.cjs");

const examples = path.resolve(__dirname, "../../../examples/02-formal-verification/src");
const read = name => fs.readFileSync(path.join(examples, name), "utf8").replace(/\r\n/g, "\n");

const mutations = [
  { file: "02-function-contracts.tspp", name: "absolute returns a negative value", from: "return -value;", to: "return value;" },
  { file: "02-function-contracts.tspp", name: "absolute promises a positive result", from: "ensures: result >= 0n;", to: "ensures: result > 0n;" },
  { file: "02-function-contracts.tspp", name: "successor promises the wrong value", from: "ensures: result === value + 1n;", to: "ensures: result === value + 2n;" },
  { file: "02-function-contracts.tspp", name: "addTwo calls successor once", from: "return successor(successor(value));", to: "return successor(value);" },
  {
    file: "02-function-contracts.tspp",
    name: "addTwo drops the precondition successor needs",
    from: "    requires: value >= 0n;\n    ensures: result === value + 2n;",
    to: "    ensures: result === value + 2n;",
  },
  { file: "03-loop-invariants.tspp", name: "a loop invariant is too weak", from: "invariant: [current >= 0n, current <= limit];", to: "invariant: [current >= 0n];" },
  { file: "03-loop-invariants.tspp", name: "the loop body breaks its invariant", from: "current += 1n;", to: "current += 2n;" },
  { file: "03-loop-invariants.tspp", name: "the invariant does not hold on entry", from: "    requires: limit >= 0n;\n", to: "" },
  { file: "04-refinement-types.tspp", name: "a refinement is introduced with a violating value", from: "const positive: Positive = 18n;", to: "const positive: Positive = 0n;" },
  { file: "04-refinement-types.tspp", name: "a refinement is widened the wrong way", from: "function widen(value: Positive): NonNegative {", to: "function widen(value: NonNegative): Positive {" },
  { file: "05-program-semantics.tspp", name: "division rounds the wrong way", from: "ensures: result === -3n;", to: "ensures: result === -4n;" },
  { file: "05-program-semantics.tspp", name: "remainder loses its divisor guard", from: "requires: divisor !== 0n;", to: "requires: true;" },
  { file: "08-structured-control-flow.tspp", name: "a branch returns a negative magnitude", from: "return -input.value;", to: "return input.value;" },
  { file: "09-recursive-data.tspp", name: "a constructor returns the wrong variant", from: "return Link(value, End);", to: "return End;" },
  {
    file: "09-recursive-data.tspp",
    name: "a match arm loses its precondition",
    from: `requires: input._tag !== "Link" || input.head >= 0n;`,
    to: "requires: true;",
  },
];

for (const file of new Set(mutations.map(mutation => mutation.file))) {
  test(`example ${file} verifies before mutation`, async () => {
    assert.deepEqual(await analyzeSource(read(file), file), []);
  });
}

for (const mutation of mutations) {
  test(`rejects a mutant where ${mutation.name}`, async () => {
    const original = read(mutation.file);
    assert.equal(original.split(mutation.from).length, 2, `'${mutation.from}' must occur exactly once in ${mutation.file}`);
    const messages = await analyzeSource(original.replace(mutation.from, mutation.to), mutation.file);
    assert.ok(messages.length > 0, `the mutant verified:\n${original.replace(mutation.from, mutation.to)}`);
  });
}
