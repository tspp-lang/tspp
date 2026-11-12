const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `type Response<T> = let Payload = {
    data: T;
    status: "ok";
} in {
    current: Payload;
    backup: Payload;
};
type Classify<T> = match T {
    0: "zero",
    string: "text",
    _: "other",
};
type Box = <Value> =>> { value: Value };
`;

test("formatting keeps type-level bindings, matches, and constructors as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of type-level bindings, matches, and constructors", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of type-level bindings, matches, and constructors", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
