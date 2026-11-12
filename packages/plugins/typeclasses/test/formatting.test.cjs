const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `typeclass Eq<A> {
    equals(a: A, b: A): boolean;
}
impl NumberEq = Eq<number> {
    equals(a, b) {
        return a === b;
    }
}
`;

test("formatting keeps typeclasses and their implementations as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of typeclasses and their implementations", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of typeclasses and their implementations", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
