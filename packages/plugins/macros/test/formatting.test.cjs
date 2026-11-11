const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, formatDocument, withoutIndentation, withDoubledSpaces } = require("../../test-support/compile.cjs");

usePlugins(require("../dist"));

const formatted = `import type { MacroContext, MacroTarget } from "ts-plus-plus/plugins/macros";
export macro function requireFunction(
    [target]: readonly MacroTarget[],
    context: MacroContext,
) {
    return undefined;
}
function answer(): number {
    return 42;
}
macro requireFunction(answer);
`;

test("formatting keeps macro declarations and invocations as they are laid out", () => {
  assert.equal(formatDocument(formatted), formatted);
});

test("formatting restores the indentation of macro declarations and invocations", () => {
  assert.equal(formatDocument(withoutIndentation(formatted)), formatted);
});

test("formatting tidies the spaces of macro declarations and invocations", () => {
  assert.equal(formatDocument(withDoubledSpaces(formatted)), formatted);
});
