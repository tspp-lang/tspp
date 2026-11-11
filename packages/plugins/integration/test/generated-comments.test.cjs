// What plugin syntax lowers to sits at the end of the syntax it replaces, right before the comments of the next
// statement, with no width and no source lines of its own. The printer must leave those comments to that statement,
// neither repeating them inside the lowered code nor moving them there when the next statement is erased, and must lay
// the lowered code out as code it generated rather than by the lines where it sits.
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

const next = "\n/** Doc of next. */\nexport function next() {}\n/** Doc of erased. */\nexport type Erased = number;\n// After everything.\nexport const last = 1;\n";

function emit(source) {
  const { program, outputs } = createProgram(source, { declaration: true });
  program.emit();
  return { javascript: outputs.get("/main.js") ?? "", declarations: outputs.get("/main.d.ts") ?? "" };
}

for (const [name, source] of Object.entries(lowered)) {
  // Without its semicolon, the syntax ends right where the next statement's comments begin.
  for (const [variant, text] of [["", source], [" without a semicolon", source.replace(/;$/, "")]]) {
    if (variant && text === source) continue;
    test(`comments after ${name}${variant} stay with the next statement`, () => {
      const { javascript, declarations } = emit(text + next);
      for (const [file, output] of [["JavaScript", javascript], ["declarations", declarations]]) {
        assert.equal(output.split("/** Doc of next. */").length - 1, 1, `${file}:\n${output}`);
        assert.match(output, /\/\*\* Doc of next\. \*\/\s*(?:export (?:declare )?)?function next/, `${file}:\n${output}`);
      }
      // Declaration output keeps only documentation comments, and JavaScript has no erased type to take one along.
      assert.equal(javascript.split("// After everything.").length - 1, 1, javascript);
      assert.doesNotMatch(javascript, /Doc of erased/, javascript);
      assert.match(declarations, /\/\*\* Doc of erased\. \*\/\s*export type Erased/, declarations);
    });
  }
}

test("lowered code is laid out as generated code, not by the lines where it sits", () => {
  const { javascript } = emit(`${lowered["data"]}\n${lowered["data class"]}\n${lowered["newtype"].replace(/;$/, "")}\n/** Doc. */\nexport const after = 1;\n`);
  assert.match(javascript, /= \{ _tag: "Dot", _values: \[\] \}/, javascript);
  assert.match(javascript, /return \{ _tag: "Circle", radius, _values: \[radius\] \};/, javascript);
  assert.match(javascript, /this\.value = value;/, javascript);
  assert.match(javascript, /return other instanceof Done && this\.value === other\.value;/, javascript);
  assert.match(javascript, /return "Done\(" \+ "value=" \+ this\.value \+ "\)";/, javascript);
  assert.match(javascript, /function Id\(value\) \{ return value; \}/, javascript);
});
