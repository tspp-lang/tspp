// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { macrosPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, macrosPlugin);
const samples = new Map([
  ["macro", "macro function expose(targets, context) { return []; }"],
  ["with", "macro function expose(targets, context) with { timeout: { type: \"fixed\", value: 2, unit: \"s\" }; } { return []; }"],
]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of macrosPlugin.facets.editor.keywords) {
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
