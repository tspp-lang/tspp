const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `class Counter {
    field count: number = 0 {
        get() {
            return field;
        }
        set(next) {
            if (next >= 0) {
                field = next;
            }
        }
    }
}
`;

test("formatting keeps fields and their accessors as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of fields and their accessors", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of fields and their accessors", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
