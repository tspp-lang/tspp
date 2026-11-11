const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `const total: number =
    let left = 20, right = 22
        in left + right;
function withValue(callback: (value: number) => number): number {
    return callback(40);
}
function compute(): number do {
    use value <- withValue;
    value + 2;
}
`;

test("formatting keeps let expressions and use bindings as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of let expressions and use bindings", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of let expressions and use bindings", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
