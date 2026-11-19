const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages, emitJavaScript } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin } = require("../dist");

usePlugins(nominalTypesPlugin);

const declarations = `
  type Ty = "int" | "bool";
  data Expr<T extends Ty> {
    Val: (value: bigint) => Expr<"int">,
    BoolVal: (value: boolean) => Expr<"bool">,
  }
  data SomeExpr {
    Some: <T extends Ty>(tag: T, expr: Expr<T>) => SomeExpr,
  }
`;
const check = source => diagnosticMessages(createProgram(source).program);

test("brace constructors retain indices and open existential fields through match", () => {
  assert.deepEqual(check(`${declarations}
    type Result<T extends Ty> = T extends "int" ? bigint : boolean;
    function evaluate<T extends Ty>(expr: Expr<T>): Result<T> {
      return match expr { Val(value) => value, BoolVal(value) => value };
    }
    function describe(pair: SomeExpr): string {
      return match pair { Some(tag, expr) => typeof evaluate(expr) };
    }
    const integer: bigint = evaluate(Val(42n));
    const flag: boolean = evaluate(BoolVal(true));
    const pair = Some("int", Val(42n));`), []);
  assert.equal(check(`${declarations}
    const wrong: Expr<"bool"> = Val(1n);
    const widened: Expr<Ty> = Val(1n);
    const mismatch = Some("bool", Val(1n));`).length, 3);
});

test("brace value constructors and zero-argument callable constructors remain distinct", () => {
  const { program, outputs } = createProgram(`
    export data Token {
      Nil: Token,
      New: () => Token,
      Generic: <T>() => Token,
    };
    export const nil = Nil;
    export const fresh = New();
    export const generic = Generic<string>();
    export const result = match fresh { Nil => 0, New => 1, Generic => 2 };
  `, { declaration: true });
  assert.deepEqual(diagnosticMessages(program), []);
  const exports = {};
  new Function("exports", emitJavaScript(program, outputs))(exports);
  assert.equal(exports.nil._tag, "Nil");
  assert.equal(exports.fresh._tag, "New");
  assert.equal(exports.generic._tag, "Generic");
  assert.equal(exports.result, 1);
  assert.equal(typeof exports.Nil, "object");
  assert.equal(typeof exports.New, "function");
  assert.match(outputs.get("/main.d.ts"), /const Nil: Token/);
  assert.match(outputs.get("/main.d.ts"), /function New\(\): Token/);
  assert.match(outputs.get("/main.d.tspp"), /New: \(\) => Token/);
  assert.equal(check(`data Token { Nil: Token, New: () => Token } Nil(); const x: Token = New;`).length, 2);
});

test("brace declarations allow optional semicolons and trailing commas without consuming following declarations", () => {
  assert.deepEqual(check(`
    data First { A: First, }
    data Second { B: Second };
    data Third { C: Third } const value: Third = C;
    data Old<T> = Empty | Full(value: T);
    const old: Old<number> = Full(1);
    const first: First = A;
    const second: Second = B;
  `), []);
});

test("brace signatures reject malformed or unsupported constructor shapes", () => {
  for (const [source, expected] of [
    [`data Expr<T> { Bad: (value: bigint) => Other<T> }`, /must return 'Expr'/],
    [`data Expr<T> { Bad: Expr }`, /must supply 1 result indices/],
    [`data Expr<T> { Bad: (value?: bigint) => Expr<bigint> }`, /named, required parameters/],
    [`data Expr<T> { Bad: (...values: bigint[]) => Expr<bigint> }`, /named, required parameters/],
    [`data Expr<T> { Bad: ({value}: {value: bigint}) => Expr<bigint> }`, /named, required parameters/],
    [`data Expr<T> { Bad: (bigint) => Expr<bigint> }`, /explicit types/],
    [`data Expr<T> { Bad: (value: bigint) => bigint }`, /must return its declared data type/],
    [`data Expr<T> { Bad: (_tag: bigint) => Expr<bigint> }`, /reserved for the data representation/],
    [`data Expr { Bad: <Expr>(value: Expr) => Expr }`, /cannot shadow its data type/],
    [`data Empty {}`, /needs at least one constructor/],
  ]) assert.match(check(source).join("\n"), expected, source);
});

test("rich brace declarations roundtrip with generic and value signatures", () => {
  const source = `${declarations.replace("data Expr", "export data Expr").replace("data SomeExpr", "export data SomeExpr")}
    export data Env<C> { Nil: Env<readonly []>, Cons: <A, C>(head: A, tail: Env<C>) => Env<readonly [A, C]> }
  `;
  const { program, outputs } = createProgram(source, { declaration: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const rich = outputs.get("/main.d.tspp");
  assert.match(rich, /data Expr<T extends Ty> \{/);
  assert.match(rich, /Some: <T extends Ty>\(tag: T, expr: Expr<T>\) => SomeExpr/);
  assert.match(rich, /Nil: Env<readonly \[\s*\]>/);
  assert.deepEqual(diagnosticMessages(createProgram({ "/lib.d.tspp": rich }).program), []);
  assert.deepEqual(diagnosticMessages(createProgram({
    "/lib.d.tspp": rich,
    "/main.tspp": `import { Expr, Val, Some } from "./lib"; const n: Expr<"int"> = Val(42n); const p = Some("int", n);`,
  }).program), []);
});
