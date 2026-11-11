// What plugin syntax lowers to sits at the end of the syntax it replaces, right before the comments of the next
// statement. The printer must leave those comments to that statement: neither repeat them inside the lowered code nor
// move them there when the next statement is erased.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createProgram } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const lowered = {
  "newtype": "export newtype Id = string;",
  "data": "export data Shape = Dot | Circle(radius: number);",
  "data class": "class Outcome {}\nexport data class Done(value: number) extends Outcome {\n  summary(): string { return \"done\"; }\n}",
  "object": "export object Origin {\n  label: string = \"origin\";\n}",
  "impl": "interface Eq<A, B> { equals(a: A, b: B): boolean; }\nclass Box<T> { constructor(readonly value: T) {} }\nimpl<T> BoxEq = Eq<Box<T>, Box<T>> where <Eq<T, T>> {\n  equals(a, b) {\n    return true;\n  }\n}",
  "do body": "export function answer() do {\n  42;\n}",
};

for (const [name, source] of Object.entries(lowered)) {
  test(`comments after ${name} stay with the next statement`, () => {
    const { program, outputs } = createProgram(`${source}\n/** Doc of next. */\nexport function next() {}\n/** Doc of erased. */\nexport type Erased = number;\n// After everything.\nexport const last = 1;\n`, { declaration: true });
    program.emit();
    const javascript = outputs.get("/main.js") ?? "";
    const declarations = outputs.get("/main.d.ts") ?? "";
    for (const [file, text] of [["JavaScript", javascript], ["declarations", declarations]]) {
      assert.equal(text.split("/** Doc of next. */").length - 1, 1, `${file}:\n${text}`);
      assert.match(text, /\/\*\* Doc of next\. \*\/\s*export (?:declare )?function next|\/\*\* Doc of next\. \*\/\s*function next/, `${file}:\n${text}`);
    }
    // Declaration output keeps only documentation comments.
    assert.equal(javascript.split("// After everything.").length - 1, 1, javascript);
    // The erased type takes its comment along in JavaScript; only the declarations keep it, before the type.
    assert.doesNotMatch(javascript, /Doc of erased/, javascript);
    assert.match(declarations, /\/\*\* Doc of erased\. \*\/\s*export type Erased/, declarations);
  });
}
