// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { dependentTypesPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, dependentTypesPlugin);
const samples = new Map([
  ["mltt", "type R: Type1 = (A: Type0) -> match mltt A { _: never };"],
  ["reify", "const runtime = reify(Bool);"],
]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of dependentTypesPlugin.facets.editor.keywords) {
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
