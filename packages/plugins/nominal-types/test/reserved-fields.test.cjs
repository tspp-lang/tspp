const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin } = require("../dist");

usePlugins(nominalTypesPlugin);

for (const field of ["_tag", "_values"]) {
  for (const declaration of [
    name => `data D = V(${name}: string);`,
    name => `data D<T> = Empty | V(value: T, /* field */ ${name}: string);`,
    name => `export declare data D<T> = V(${name}: T) | Empty;`,
  ]) {
    test(`data rejects reserved field ${field}: ${declaration(field)}`, () => {
      const source = declaration(field);
      const { program } = createProgram(source);
      const diagnostics = program.getSyntacticDiagnostics();
      assert.equal(diagnostics.length, 1);
      assert.equal(source.slice(diagnostics[0].start, diagnostics[0].start + diagnostics[0].length), field);
      assert.deepEqual(diagnosticMessages(program), [
        `The field name '${field}' is reserved for the data representation.`,
      ]);
    });
  }
}

test("escaped reserved field names are rejected at their authored spelling", () => {
  for (const [spelling, name] of [[String.raw`\u005ftag`, "_tag"], [String.raw`_val\u0075es`, "_values"]]) {
    const source = `data D = V( /* field */ ${spelling}: number);`;
    const { program } = createProgram(source);
    const diagnostics = program.getSyntacticDiagnostics();
    assert.equal(diagnostics.length, 1);
    assert.equal(source.slice(diagnostics[0].start, diagnostics[0].start + diagnostics[0].length), spelling);
    assert.deepEqual(diagnosticMessages(program), [
      `The field name '${name}' is reserved for the data representation.`,
    ]);
  }
});

test("multiple reserved fields report separately and parsing continues", () => {
  const { program } = createProgram("data D = V(_tag: string, _values: number, value: boolean) | Empty; const after: number = 1;");
  assert.deepEqual(diagnosticMessages(program), [
    "The field name '_tag' is reserved for the data representation.",
    "The field name '_values' is reserved for the data representation.",
  ]);
});

test("data reads, other underscore fields, ordinary objects, and nested types remain valid", () => {
  const { program } = createProgram(`
    data D<T> = V(_value: T, _tags: string, _valuesExtra: number, nested: { _tag: string; _values: number });
    const ordinary = { _tag: "user", _values: 1 };
    function identity(_tag: string, _values: number) { return { _tag, _values }; }
    class Ordinary { _tag = "user"; _values = 1; }
    const value = V(1, "ok", 2, ordinary);
    const tag: "V" = value._tag;
    const first: number = value._values[0];
    const field: number = value._value;
    const nestedTag: string = value.nested._tag;
    const selected: number = match value { V(n, tags, extra, nested) => n };
  `);
  assert.deepEqual(diagnosticMessages(program), []);
});
