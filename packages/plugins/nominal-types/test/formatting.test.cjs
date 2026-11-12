const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `data Option<T> = None | Some(value: T);
newtype UserId = string;
function unwrap(option: Option<number>): number {
    return match option {
        Some(value) => value,
        None => 0,
    };
}
`;

test("formatting keeps data declarations, newtypes, and match expressions as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of data declarations, newtypes, and match expressions", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of data declarations, newtypes, and match expressions", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
