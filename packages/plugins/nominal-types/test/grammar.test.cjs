// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { getTSPPEditorKeywords } = require("@tspp/plugin-sdk/editor");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { nominalTypesPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, nominalTypesPlugin);
const samples = new Map([
  ["newtype", "newtype UserId = number;"],
  ["data", "data Option<T> = None | Some(value: T);"],
  ["match", "const n = match option { None => 0, Some(value) => value };"],
]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of getTSPPEditorKeywords(nominalTypesPlugin)) {
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
