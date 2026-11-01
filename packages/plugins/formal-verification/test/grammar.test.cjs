// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { getTSPPEditorKeywords } = require("@tspp/plugin-sdk/editor");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { formalVerificationPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, formalVerificationPlugin);
const samples = new Map([
  ["assert", "assert: x > 0n;"],
  ["assume", "assume: x > 0n;"],
  ["with", "function f(x: bigint) with { requires: x > 0n; }: bigint { return x; }"],
  ["requires", "function f(x: bigint) with { requires: x > 0n; }: bigint { return x; }"],
  ["ensures", "function f(x: bigint) with { ensures: result > x; }: bigint { return x; }"],
  ["invariant", "while (i < n) with { invariant: i >= 0n; } { i += 1n; }"],
  ["predicate", "type Positive = bigint with { predicate: value > 0n; };"],
  ["numberModel", "function f(x: number) with { numberModel: \"safe-integer\"; }: number { return x; }"],
]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of getTSPPEditorKeywords(formalVerificationPlugin)) {
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
