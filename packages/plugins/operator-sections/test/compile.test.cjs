// End-to-end behavior ported from the legacy-monolith compiler tests (unittests/tspp/operatorSections.ts).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
const { operatorSectionsPlugin } = require("../dist");

usePlugins(operatorSectionsPlugin);

function compile(source) {
  const { program, outputs } = createProgram(source);
  return { messages: diagnosticMessages(program), javascript: emitJavaScript(program, outputs) };
}

const parameter = String.raw`([A-Za-z_$][\w$]*)`;

test("desugars a single placeholder into a unary arrow function", () => {
  const { messages, javascript } = compile(`const add1: (x: number) => number = (_ + 1);`);
  assert.deepEqual(messages, []);
  assert.match(javascript, new RegExp(String.raw`\(?${parameter}\)?\s*=>\s*\1\s*\+\s*1`));
});

test("desugars each placeholder into its own parameter, left to right", () => {
  const { messages, javascript } = compile(`const add: (a: number, b: number) => number = (_ + _);`);
  assert.deepEqual(messages, []);
  assert.match(javascript, new RegExp(String.raw`\(${parameter},\s*${parameter}\)\s*=>\s*\1\s*\+\s*\2`));
});

test("supports property access on a placeholder", () => {
  const { messages, javascript } = compile(`const getName: (obj: { name: string }) => string = (_.name);`);
  assert.deepEqual(messages, []);
  assert.match(javascript, new RegExp(String.raw`\(?${parameter}\)?\s*=>\s*\1\.name`));
});

test("supports placeholders directly in call arguments", () => {
  const { messages, javascript } = compile(`
    declare function mapNumbers(fn: (x: number) => number): void;
    mapNumbers(_ * 2);
  `);
  assert.deepEqual(messages, []);
  assert.match(javascript, new RegExp(String.raw`mapNumbers\(\(?\(?${parameter}\)?\s*=>\s*\1\s*\*\s*2\)?\)`));
});

test("infers type predicates for sections passed to filter", () => {
  const { program } = createProgram(`
    const numbers = [1, "text"].filter(typeof _ === "number");
    const narrowed: number[] = numbers;
    [1, 2].filter((_ !== 1));
  `, { noLib: false, types: [] });
  assert.deepEqual(diagnosticMessages(program), []);
});

test("leaves parentheses without placeholders intact", () => {
  const { messages, javascript } = compile(`const x = (1 + 2);`);
  assert.deepEqual(messages, []);
  assert.match(javascript, /const x = \(1 \+ 2\);/);
  assert.doesNotMatch(javascript, /=>/);
});

test("describes a placeholder by its contextual parameter type", () => {
  const source = "const add1: (x: number) => number = (_ + 1);";
  const quickInfo = createLanguageService("/main.tspp", source).getQuickInfoAtPosition("/main.tspp", source.indexOf("_"));
  assert.ok(quickInfo);
  assert.equal(ts.displayPartsToString(quickInfo.displayParts), "(parameter) _: number");
});

test("offers code fixes for an untyped placeholder without crashing", () => {
  // Without a contextual type the placeholder is an implicit-any parameter, and editors request quick fixes for it.
  for (const source of ["const increment = (_ + 1);\nincrement(2);", "const nameOf = (_.name);"]) {
    const service = createLanguageService("/main.tspp", source);
    const diagnostics = service.getSemanticDiagnostics("/main.tspp");
    assert.ok(diagnostics.some(diagnostic => diagnostic.code === 7006), source);
    for (const diagnostic of diagnostics) {
      const end = diagnostic.start + diagnostic.length;
      assert.doesNotThrow(() => service.getCodeFixesAtPosition("/main.tspp", diagnostic.start, end, [diagnostic.code], {}, {}));
    }
  }
});

test("a section can be called and nested like any parenthesized expression", () => {
  const { messages, javascript } = compile(`
    const three: number = (_ + 1)(2);
    const scaled: (x: number) => number = (_ * (_ + 1)(2));
    const identity: (x: string) => string = (_);
  `);
  assert.deepEqual(messages, []);
  assert.match(javascript, new RegExp(String.raw`const three = \(\(${parameter}\) => \1 \+ 1\)\(2\);`));
  assert.match(javascript, new RegExp(String.raw`const identity = \(\(${parameter}\) => \1\);`));
});

test("placeholders inside functions and object literals are not holes", () => {
  const { messages } = compile(`const f = (x: number) => (y => _); const o = ({ a: _ });`);
  assert.deepEqual(messages.filter(message => /Cannot find name '_'/.test(message)).length, 2, messages.join("\n"));
});
