const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { usePlugins, createProgram, diagnosticMessages, emitJavaScript } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin } = require("../dist");

usePlugins(nominalTypesPlugin);
const options = { noLib: false, lib: ["lib.es2022.d.ts"] };
const check = source => diagnosticMessages(createProgram(source, options).program);
const expressions = `
  data Expr<T extends "int" | "bool"> =
    Val(value: bigint): Expr<"int"> | Flag(value: boolean): Expr<"bool">;
`;

test("concrete indices omit impossible constructors from exhaustiveness", () => {
  assert.deepEqual(check(`${expressions}
    function integer(expression: Expr<"int">): bigint {
      return match expression { Val(value) => value };
    }`), []);
  assert.ok(check(`${expressions}
    function missing<T extends "int" | "bool">(expression: Expr<T>) {
      return match expression { Val(value) => value };
    }`).some(message => /Missing patterns: Flag/.test(message)));
});

test("wildcard-only indexed matches need no constructor evidence", () => {
  assert.deepEqual(check(`${expressions}
    function ignore<T extends "int" | "bool">(expression: Expr<T>): number {
      return match expression { _ => 1 };
    }`), []);
});

test("nested constructor patterns preserve field types and dependent equations", () => {
  assert.deepEqual(check(`${expressions}
    data Wrapped = Wrap<T extends "int" | "bool">(expression: Expr<T>): Wrapped;
    function evaluate(value: Wrapped): bigint | boolean {
      return match value {
        Wrap(Val(number)) => number,
        Wrap(Flag(boolean)) => boolean
      };
    }`), []);
  assert.deepEqual(check(`${expressions}
    data Wrapped = Wrap(expression: Expr<"int">): Wrapped;
    function evaluate(value: Wrapped): bigint {
      return match value { Wrap(Val(number)) => number };
    }`), []);
});

test("structural aliases that erase an argument never establish equality of that argument", () => {
  const diagnostics = check(`
    type Erase<A> = { readonly kind: "same" };
    data Witness<T> = Make<A>(value: A): Witness<Erase<A>>;
    const value: Witness<Erase<number>> = Make("oops");
    const wrong: number = match value { Make(payload) => payload };
  `);
  assert.ok(diagnostics.some(message => /assignable/.test(message)), diagnostics.join("\n"));
});

test("hidden indices cannot escape in indexed accesses or closures", () => {
  for (const body of ["value", "() => value", "({ value })"]) {
    const diagnostics = check(`
      data Packed = Pack<A extends { x: unknown }>(value: A["x"]): Packed;
      declare const packed: Packed;
      export const leak = match packed { Pack(value) => ${body} };
    `);
    assert.ok(diagnostics.some(message => /hidden constructor type escapes/.test(message)), `${body}: ${diagnostics.join("\n")}`);
  }
});

test("hidden indices cannot escape in lazy conditional and mapped types", () => {
  for (const type of ["A extends string ? string : number", "{ [K in keyof A]: A[K] }"]) {
    const diagnostics = check(`
      data Packed = Pack<A>(value: ${type}): Packed;
      declare const packed: Packed;
      export const leak = match packed { Pack(value) => value };
    `);
    assert.ok(diagnostics.some(message => /hidden constructor type escapes/.test(message)), `${type}: ${diagnostics.join("\n")}`);
  }
});

test("hidden indices cannot escape through generic bounds, defaults, classes, or index signatures", () => {
  for (const body of ["<B extends typeof value>(b: B): B => b", "<B = typeof value>(b: B): B => b", "class { x = value }", "({ get(key: string) { return value; } })"]) {
    const diagnostics = check(`
      data Packed = Pack<A>(value: A): Packed;
      declare const packed: Packed;
      export const leak = match packed { Pack(value) => ${body} };
    `);
    assert.ok(diagnostics.some(message => /hidden constructor type escapes/.test(message)), `${body}: ${diagnostics.join("\n")}`);
  }
  assert.ok(check(`
    data Packed = Pack<A>(value: { [key: string]: A }): Packed;
    declare const packed: Packed;
    export const leak = match packed { Pack(value) => value };
  `).some(message => /hidden constructor type escapes/.test(message)));
});

test("a computed scrutinee is evaluated once and guarded bodies retain their index", () => {
  const { program, outputs } = createProgram(`${expressions}
    let calls = 0;
    function make(): Expr<"int"> { calls++; return Val(4n); }
    export const result: bigint = match make() {
      Val(value) if value > 0n => value + 1n,
      Val(value) => value
    };
    export const count = calls;
  `, options);
  assert.deepEqual(diagnosticMessages(program), []);
  const exports = {};
  vm.runInThisContext(`(function(exports) { ${emitJavaScript(program, outputs)} })`)(exports);
  assert.equal(exports.count, 1);
  assert.equal(exports.result, 5n);
});

test("a hidden value index widens to its constraint when it is returned", () => {
  const sized = `
    type Vec<T, N extends number, Items extends T[] = []> = Items["length"] extends N ? Items : Vec<T, N, [...Items, T]>;
    data Sized { Sized: <N extends number>(length: N, items: Vec<number, N>) => Sized }
    declare const sized: Sized;`;
  assert.deepEqual(check(`${sized}
    export const length = match sized { Sized(length, items) => length };
    export const checked: number = length;`), []);
  // The items' type has no supertype to stand for it, so it still has to be wrapped.
  assert.ok(check(`${sized}
    export const leak = match sized { Sized(length, items) => items };`).some(message => /hidden constructor type escapes/.test(message)));
  // A hidden type without a primitive constraint would only widen to `unknown`.
  assert.ok(check(`
    data Packed = Pack<A>(value: A): Packed;
    declare const packed: Packed;
    export const leak = match packed { Pack(value) => value };`).some(message => /hidden constructor type escapes/.test(message)));
});
