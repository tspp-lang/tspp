// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { typeComputationPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, typeComputationPlugin);
const samples = new Map([
  ["let", "type Y = let X = number in X;"],
  ["in", "type Y = let X = number in X;"],
  ["match", "type Name<T> = match T { 1: \"one\", _: \"many\" };"],
  ["infer", "type E<T> = match T { Array<infer U>: U, _: never };"],
]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of typeComputationPlugin.facets.editor.keywords) {
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
