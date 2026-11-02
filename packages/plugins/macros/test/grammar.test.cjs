// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { getTSPPEditorKeywords } = require("@tspp/plugin-sdk/editor");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { macrosPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, macrosPlugin);
const samples = new Map([
  ["macro", "macro function expose(targets, context) { return []; }"],
]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of getTSPPEditorKeywords(macrosPlugin)) {
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("highlights the keyword of a macro with options and of an invocation", () => {
  assertScoped(grammars, 'export macro({ timeout: { type: "fixed", value: 2, unit: "s" } }) function expose() {}', "macro");
  assertScoped(grammars, "macro expose(User);", "macro");
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
