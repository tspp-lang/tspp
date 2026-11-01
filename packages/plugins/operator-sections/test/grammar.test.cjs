// Editor grammar contract adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadGrammars, scopesIn, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { operatorSectionsPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, operatorSectionsPlugin);

test("highlights placeholders but not identifiers that merely contain an underscore", () => {
  assertScoped(grammars, "const add1 = (_ + 1);", "_", /placeholder/);
  assert.deepEqual(scopesIn(grammars, "const my_value = _private;").filter(entry => /placeholder/.test(entry.scope)), []);
});

test("leaves generic angle brackets to TypeScript", () => {
  assertLeavesAngleBracketsToTypeScript(grammars);
  assert.deepEqual(scopesIn(grammars, "const xs: Array<number> = [];").filter(entry => /^[<>]$/.test(entry.text)), []);
});
