const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `function absolute(value: bigint) with {
    ensures: result >= 0n;
}: bigint {
    if (value >= 0n) return value;
    return -value;
}
`;

test("formatting keeps function contracts as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of function contracts", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of function contracts", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
