const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `effect Logger {
    info(message: string): void;
}
function greet(name: string) / Logger: void {
    perform Logger.info(name);
}
handle Logger {
    info: message => console.log(message),
} in {
    greet("world");
};
`;

test("formatting keeps effects, effect rows, perform, and handle as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of effects, effect rows, perform, and handle", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of effects, effect rows, perform, and handle", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
