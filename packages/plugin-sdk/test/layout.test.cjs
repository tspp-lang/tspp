const assert = require("node:assert/strict");
const { test } = require("node:test");
const { layoutTSPPCode } = require("../dist/language-service");

const options = { indentSize: 4, tabSize: 4, convertTabsToSpaces: true, newLineCharacter: "\n" };

/** Lays out all of `text` as one range whose first line has `base` columns, and applies the edits. */
function layout(text, layoutOptions, base = 0) {
  const request = {
    fileName: "/test.tspp",
    sourceText: text,
    start: 0,
    end: text.length,
    options,
    isOwned: () => true,
    ownedRanges: () => [{ start: 0, end: text.length }],
    unformattedRanges: () => [],
    indentationAt: () => base,
  };
  const edits = layoutTSPPCode(request, [{ start: 0, end: text.length }], layoutOptions);
  let result = text;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.newText + result.slice(edit.start + edit.length);
  }
  return { edits, result };
}

test("indents lines inside brackets from the line that opened them", () => {
  assert.equal(
    layout("impl Show = Show<number> {\nshow(value) {\nreturn String(value);\n}\n}\n").result,
    "impl Show = Show<number> {\n    show(value) {\n        return String(value);\n    }\n}\n",
  );
});

test("indents brackets opened on one line once", () => {
  assert.equal(layout("call({\nkey: 1,\n});\n").result, "call({\n    key: 1,\n});\n");
});

test("indents a type argument list left open at the end of a line", () => {
  assert.equal(layout("type Result = If<\nTrue,\nstring\n>;\n").result, "type Result = If<\n    True,\n    string\n>;\n");
});

test("indents continuation lines after and before operators and continuation words", () => {
  assert.equal(layout("const value =\nlet a = 1\nin a + 1;\n", { continuationWords: ["in"] }).result, "const value =\n    let a = 1\n        in a + 1;\n");
  assert.equal(layout("const value = ready\n? 1\n: 2;\n").result, "const value = ready\n    ? 1\n    : 2;\n");
});

test("starts from the indentation of the range's first line", () => {
  assert.equal(layout("field count = 0 {\nget() {\nreturn field;\n}\n}\n", {}, 4).result, "    field count = 0 {\n        get() {\n            return field;\n        }\n    }\n");
});

test("collapses spaces between code and tightens them at brackets and separators", () => {
  assert.equal(layout("newtype  UserId  =  Brand( string ) ,  other;\n").result, "newtype UserId = Brand(string), other;\n");
});

test("leaves comments, strings, and template text as they are", () => {
  const text = "const a = `line\n    kept  as  is`;\n/* comment\n      body  */\nconst b = \"two  spaces\"; // note  here\n";
  assert.equal(layout(text).result, text);
});

test("lays out a line that starts with a string", () => {
  assert.equal(layout("join(\n\"left\",\n`right`\n);\n").result, "join(\n    \"left\",\n    `right`\n);\n");
});

test("removes trailing spaces of code", () => {
  assert.equal(layout("let a = 1;   \nlet b = 2;\n").result, "let a = 1;\nlet b = 2;\n");
});

test("decisive layout also returns the edits that change nothing", () => {
  const { edits } = layout("block {\n    inner;\n}\n", { decisive: true });
  assert.ok(edits.length > 0);
  assert.ok(edits.every(edit => edit.decisive));
  assert.ok(edits.every(edit => "block {\n    inner;\n}\n".slice(edit.start, edit.start + edit.length) === edit.newText));
  assert.deepEqual(layout("block {\n    inner;\n}\n").edits, []);
});
