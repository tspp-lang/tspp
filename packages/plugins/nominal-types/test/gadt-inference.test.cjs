const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin } = require("../dist");

usePlugins(nominalTypesPlugin);
const check = source => diagnosticMessages(createProgram(source, { noLib: false, lib: ["lib.es2022.d.ts"] }).program);

test("contextual constructor specialization checks dependent type parameter bounds", () => {
  const declaration = `
    data Related<T> {
      Make: <A, B extends A>(left: A, right: B) => Related<{ left: A; right: B }>,
    }
  `;
  assert.deepEqual(check(`${declaration}
    const value: Related<{ left: string; right: "text" }> = Make("left", "text");
  `), []);
  assert.ok(check(`${declaration}
    const value: Related<{ left: "int"; right: "bool" }> = Make("int", "bool");
  `).some(message => /constraint|assignable/.test(message)));
});

test("contextual constructors preserve readonly tails and reject wrong arguments", () => {
  const declaration = `
    data Proof<C extends readonly unknown[], T> {
      Here: <R extends readonly unknown[], T>() => Proof<readonly [T, ...R], T>,
    }
  `;
  assert.deepEqual(check(`${declaration}
    const value: Proof<readonly [number, string], number> = Here();
  `), []);
  assert.ok(check(`${declaration}
    const value: Proof<readonly [number, string], boolean> = Here();
  `).length > 0);
});

test("reused and explicitly supplied constructors retain their ordinary function checks", () => {
  const declaration = `
    data Value<T> { Make: <T>(value: T) => Value<T>, }
    const make = Make;
  `;
  assert.deepEqual(check(`${declaration}
    const value: Value<string> = make("text");
    const explicit: Value<number> = Make<number>(1);
  `), []);
  for (const invalid of [
    'const value: Value<string> = make(1);',
    'const value: Value<string> = Make<string>(1);',
    'const value: Value<string> = Make();',
    'const value: Value<string> = Make("text", "extra");',
  ]) assert.ok(check(`${declaration}\n${invalid}`).length > 0, invalid);
});
