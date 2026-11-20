const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages, emitJavaScript } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin, nominalTypesADTAPI } = require("../dist");

usePlugins(nominalTypesPlugin);

const declarations = `
  type Ty = "int" | "bool";
  data Expr<T extends Ty> = Val(value: bigint): Expr<"int"> | BoolVal(value: boolean): Expr<"bool">;
  data SomeExpr = Some<T extends Ty>(tag: T, expr: Expr<T>): SomeExpr;
`;
const check = source => diagnosticMessages(createProgram(source).program);

test("indexed constructors return their declared index and preserve it invariantly", () => {
  assert.deepEqual(check(`${declarations}
    const n: Expr<"int"> = Val(1n);
    const b: Expr<"bool"> = BoolVal(true);
    const some: SomeExpr = Some("int", n);`), []);
  const errors = check(`${declarations}
    const wrong: Expr<"bool"> = Val(1n);
    const widened: Expr<Ty> = Val(1n);
    const mismatch = Some("bool", Val(1n));`);
  assert.equal(errors.length, 3, errors.join("\n"));
});

test("existential fields cannot be read as a particular type outside a checked match", () => {
  const errors = check(`${declarations}
    const some = Some("int", Val(1n));
    const leaked: Expr<"int"> = some.expr;`);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.match(errors[0], /unknown/);
});

test("indexed declarations reject a foreign result, wrong index count, and mixed constructors", () => {
  assert.match(check(`data Expr<T> = Val(value: bigint): Other<T>;`).join("\n"), /must return 'Expr'/);
  assert.match(check(`data Expr<T> = Val(value: bigint): Expr;`).join("\n"), /must supply 1 result indices/);
  assert.match(check(`data Expr<T> = Val(value: bigint): Expr<bigint> | Other(value: T);`).join("\n"), /Every constructor/);
  assert.match(check(`data Expr = Val<T>(value: T);`).join("\n"), /needs an explicit result type/);
  assert.match(check(`data Expr = Val<Expr>(value: Expr): Expr;`).join("\n"), /cannot shadow its data type/);
  assert.match(check(`data Expr<T> = Val(_tag: string): Expr<bigint>;`).join("\n"), /reserved for the data representation/);
});

test("constructors with local parameters work at runtime, including nullary generic constructors", () => {
  const { program, outputs } = createProgram(`${declarations}
    data Token<T> = NewToken<T>(): Token<T>;
    export const result = Some("int", Val(42n));
    export const token = NewToken<string>();`);
  assert.deepEqual(diagnosticMessages(program), []);
  const exports = {};
  new Function("exports", emitJavaScript(program, outputs))(exports);
  assert.equal(exports.result._tag, "Some");
  assert.equal(exports.result.expr.value, 42n);
  assert.equal(exports.token._tag, "NewToken");
});

test("rich and compatible declarations preserve GADT signatures and invariant indices", () => {
  const source = declarations.replace("data Expr", "export data Expr").replace("data SomeExpr", "export data SomeExpr");
  const { program, outputs } = createProgram(source, { declaration: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const rich = outputs.get("/main.d.tspp");
  const compatible = outputs.get("/main.d.ts");
  assert.match(rich, /Val\(value: bigint\): Expr<"int">/);
  assert.match(rich, /Some<T extends Ty>\(tag: T, expr: Expr<T>\): SomeExpr/);
  assert.match(compatible, /protected readonly __tsppIndex: \(indices: \[T\]\) => \[T\]/);
  assert.match(compatible, /function Some<T extends Ty>\(tag: T, expr: Expr<T>\): SomeExpr/);
  assert.deepEqual(diagnosticMessages(createProgram({ "/main.d.tspp": rich }).program), []);
  const ordinaryConsumer = createProgram({
    "/lib.d.ts": compatible,
    "/main.ts": `import { Expr, Val } from "./lib"; const wrong: Expr<"int" | "bool"> = Val(1n);`,
  }).program;
  assert.equal(diagnosticMessages(ordinaryConsumer).length, 1);
});

test("the public ADT description retains constructor parameters and result indices", () => {
  const [expr, some] = nominalTypesADTAPI.getDataTypes(declarations);
  assert.equal(expr.variants[0].resultType, 'Expr<"int">');
  assert.deepEqual(some.variants[0].typeParameters, ["T extends Ty"]);
  assert.equal(some.variants[0].resultType, "SomeExpr");
  assert.deepEqual(some.variants[0].fields, [{ name: "tag", type: "T" }, { name: "expr", type: "Expr<T>" }]);
});

test("aliases preserve the actual data indices, including unused and reordered wrapper parameters", () => {
  assert.deepEqual(check(`${declarations}
    type Alias<T extends Ty> = Expr<T>;
    type Reordered<A, B extends Ty> = Expr<B>;
    function evaluate<T extends Ty>(expr: Alias<T>): T extends "int" ? bigint : boolean {
      return match expr { Val(value) => value, BoolVal(value) => value };
    }
    function evaluateReordered<A, B extends Ty>(expr: Reordered<A, B>): B extends "int" ? bigint : boolean {
      return match expr { Val(value) => value, BoolVal(value) => value };
    }
    const n: bigint = evaluate(Val(1n));
    const b: boolean = evaluateReordered(BoolVal(true));`), []);
});
