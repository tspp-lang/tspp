const test = require("node:test");
const { expectVerification } = require("./analyze.cjs");

test("checks string length in contracts and bodies using the selected number model", async () => {
  await expectVerification({ source: `
function measure(text: string) with {
  numberModel: "safe-integer";
  requires: text.length > 0;
  ensures: [result === text.length, result <= 9007199254740991];
}: number { return text.length; }

function measureAsReal(text: string) with {
  numberModel: "mathematical-real";
  ensures: [result === text.length, result >= 0];
}: number { return text.length; }
` });
});

test("counts UTF-16 code units and keeps SMT-looking text literal", async () => {
  await expectVerification({ source: String.raw`
import * as smt from "ts-plus-plus/plugins/formal-verification/smt";
const isEscaped = smt.definePredicate([["text", smt.String]], text => text === "\\u{41}");

function unicode() with {
  numberModel: "safe-integer";
  ensures: [result === "\u{1F642}\uD800\u0000", result.length === 4, ("\u{1F642}").length === 2];
}: string {
  const text = "🙂\uD800\0";
  assert: text.length === 4;
  return text;
}

function escaped() with {
  ensures: [result === '\\u{41}', result !== "A", isEscaped(result)];
}: string { return "\\u{41}"; }
` });
});

test("measures data constructor tags in postconditions", async () => {
  await expectVerification({ source: `
data Mark = Empty | Marked(value: bigint);
function empty() with { ensures: [result._tag === "Empty", result._tag.length === 5]; }: Mark { return Empty; }
function marked() with {
  ensures: [result._tag === "Marked", result._tag.length === 6];
}: Mark { return Marked(0n); }
` });
});

test("preserves record fields called length and measures their string siblings", async () => {
  await expectVerification({ source: `
function read(record: { length: bigint; name: string }) with {
  numberModel: "safe-integer";
  requires: [record.length === 3n, record.name.length === 2];
  ensures: result === record.length;
}: bigint {
  assert: record.name.length === 2;
  return record.length;
}
` });
});

test("rejects writes to a string's read-only length", async () => {
  for (const write of ["text.length = 0", "text.length++"]) {
    await expectVerification({
      source: `function overwrite(text: string) with {
        numberModel: "safe-integer"; ensures: result === 0;
      }: number { ${write}; return text.length; }`,
      rejects: /String properties are read-only in verification/,
    });
  }
});
