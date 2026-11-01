const assert = require("node:assert/strict");
const { test } = require("node:test");
const { getCodeDecorationSpans } = require("../dist/editor");

function decoratedText(text) {
  return getCodeDecorationSpans(text, { start: 0, length: text.length })
    .map(span => text.slice(span.start, span.start + span.length));
}

test("code decorations exclude whitespace and comments", () => {
  const text = "work(); // explanation\n/* detail */ next();";
  assert.deepEqual(decoratedText(text), ["work();", "next();"]);
});

test("comment-like text inside strings and templates remains code", () => {
  const text = "const url = 'https://example.test'; const note = `// text`;";
  assert.deepEqual(decoratedText(text), [
    "const", "url", "=", "'https://example.test';", "const", "note", "=", "`// text`;",
  ]);
});

test("comments inside template expressions are excluded", () => {
  const text = "`value: ${input /* explanation */ + 1}`";
  assert.deepEqual(decoratedText(text), ["`value: ${input", "+", "1}`"]);
});
