// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { getTSPPEditorKeywords } = require("@tspp/plugin-sdk/editor");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { modernSyntaxPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, modernSyntaxPlugin);
const samples = new Map([
  ["let", "const a = let x = 1 in x;"],
  ["do", "const b = do { 1; };"],
  ["use", "use r <- withResource();"],
  ["def", "def x = 1;"],
]);

// TypeScript's own grammar already scopes `in` as an operator keyword, including in `let ... in`.
const highlightedByTypeScript = new Set(["in"]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of getTSPPEditorKeywords(modernSyntaxPlugin)) {
    if (highlightedByTypeScript.has(keyword)) continue;
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
