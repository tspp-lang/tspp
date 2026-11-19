// Indexed data constructors and type-level matching must retain their relationship
// across function bodies, runtime-selected result types, and declaration emit.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { createProgram, diagnosticMessages, emitJavaScript } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const interpreter = fs.readFileSync(path.resolve(__dirname, "../../../examples/10-dependent-types/src/10-gadt-interpreter.tspp"), "utf8");
const contextInterpreter = fs.readFileSync(path.resolve(__dirname, "../../../examples/10-dependent-types/src/11-context-interpreter.tspp"), "utf8");
const options = { noLib: false, lib: ["lib.es2022.d.ts"] };
const messages = source => diagnosticMessages(createProgram(source, options).program);

test("the standalone Idris-style interpreter includes variables, lambdas, factorial, and dynamic result witnesses", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../../../examples/10-dependent-types/src/12-well-typed-interpreter.tspp"), "utf8");
  const { program, outputs } = createProgram(source, options);
  assert.deepEqual(diagnosticMessages(program), []);
  const exports = {};
  vm.runInThisContext(`(function (exports, module) {\n${emitJavaScript(program, outputs)}\n})`)(exports, { exports });
  assert.equal(exports.additionResult, 42n);
  assert.equal(exports.factorialResult, 720n);
  assert.equal(exports.dynamicInteger.value, 720n);
  assert.equal(exports.dynamicBoolean.value, true);
  assert.equal(exports.dynamicFunction.value(5n), 120n);
  assert.equal(exports.dynamicIntegerText, "720");
  assert.equal(exports.dynamicBooleanText, "true");
  assert.equal(exports.dynamicFunctionText, "<function>");
  assert.ok(messages(`${source}\nexport const wrong = Some(BooleanType, Val<readonly []>(1n));`).length > 0);
  assert.ok(messages(`${source}\nexport const wrong = Evaluated(BooleanType, 1n);`).length > 0);
});

test("indexed expressions evaluate with a checked type-family result and user-defined dynamic pairs", () => {
  const { program, outputs } = createProgram(interpreter, options);
  assert.deepEqual(diagnosticMessages(program), []);
  const exports = {};
  vm.runInThisContext(`(function (exports, module) {\n${emitJavaScript(program, outputs)}\n})`)(exports, { exports });
  assert.equal(exports.integerResult, 42n);
  assert.equal(exports.booleanResult, true);
  assert.equal(exports.dynamicInteger._tag, "Evaluated");
  assert.equal(exports.dynamicInteger.tag, "int");
  assert.equal(exports.dynamicInteger.value, 42n);
  assert.equal(exports.dynamicBoolean.tag, "bool");
  assert.equal(exports.dynamicBoolean.value, true);
});

test("context-indexed variables, environments, lambdas, and delayed recursion evaluate without assertions", () => {
  const files = { "/10-gadt-interpreter.tspp": interpreter, "/main.tspp": contextInterpreter };
  const { program, outputs } = createProgram(files, options);
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const javaScript = outputs.get("/main.js");
  assert.ok(javaScript, "The context interpreter emitted no JavaScript");
  const exports = {};
  vm.runInThisContext(`(function (exports, module) {\n${javaScript}\n})`)(exports, { exports });
  assert.equal(exports.additionResult, 42n);
  assert.equal(exports.factorialResult, 720n);
  for (const invalid of [
    `export const bad: HasType<readonly [], "int"> = Stop<readonly [], "int">();`,
    `export const bad = lookup(Stop<readonly [], "int">(), Nil);`,
    `export const bad: Env<readonly ["bool"]> = Cons<"int", readonly []>(1n, Nil);`,
    `export const bad: Expr<readonly [], Fun<"bool", "int">> = add;`,
  ]) {
    files["/main.tspp"] = `${contextInterpreter}\n${invalid}`;
    assert.ok(diagnosticMessages(createProgram(files, options).program).length > 0, `Accepted invalid context:\n${invalid}`);
  }
});

test("constructor dependencies reject wrong calls, mixed branches, and forged dependent pairs", () => {
  for (const invalid of [
    `export const bad: Expr<"bool"> = Val(1n);`,
    `export const bad = App(Host<"int", "bool">(value => value === 0n), BoolVal(true));`,
    `export const bad = If(Val(1n), Val(2n), Val(3n));`,
    `export const bad = If(BoolVal(true), Val(1n), BoolVal(false));`,
    `export const bad = Some("bool", Val(1n));`,
    `export const bad = Evaluated("bool", 1n);`,
  ]) {
    const diagnostics = messages(`${interpreter}\n${invalid}`);
    assert.ok(diagnostics.length > 0, `Accepted invalid indexed construction:\n${invalid}`);
    assert.ok(diagnostics.some(message => /assignable|index|match|type|argument/i.test(message)), diagnostics.join("\n"));
  }
});

test("each interpreter branch checks its value against the refined result type", () => {
  const wrongInteger = interpreter.replace("Val(value) => value,", 'Val(value) => "wrong",');
  const wrongBoolean = interpreter.replace("BoolVal(value) => value,", "BoolVal(value) => 1n,");
  assert.ok(messages(wrongInteger).length > 0, "An integer expression returned a string");
  assert.ok(messages(wrongBoolean).length > 0, "A boolean expression returned an integer");
});

test("match equations remain local to the arm and never alter another generic function", () => {
  const source = `
    type Kind = "int" | "bool";
    type Value<T extends Kind> = match T { "int": bigint, "bool": boolean, _: never };
    data IntOnly<T extends Kind> { IntWitness: IntOnly<"int">, }
    function local<T extends Kind>(witness: IntOnly<T>, value: Value<T>): Value<T> {
      const seen = match witness { IntWitness => 0 };
      return 1n;
    }
    function independent<T extends Kind>(value: Value<T>): Value<T> {
      return 1n;
    }
    export { local, independent };
  `;
  const diagnostics = messages(source);
  assert.equal(diagnostics.length, 2, diagnostics.join("\n"));
  for (const diagnostic of diagnostics) assert.match(diagnostic, /not assignable/);
});

test("independent existential constructors never establish the same hidden index", () => {
  const diagnostics = messages(`${interpreter}
    declare function equalIndex<T extends Ty>(left: Expr<T>, right: Expr<NoInfer<T>>): boolean;
    export function compare(left: SomeExpr, right: SomeExpr): boolean {
      return match left {
        Some(leftTag, leftExpression) => match right {
          Some(rightTag, rightExpression) => equalIndex(leftExpression, rightExpression)
        }
      };
    }`);
  assert.ok(diagnostics.length > 0, "Independent existential indices were unified");
});

test("existential payloads cannot escape unless their index is packaged with them", () => {
  const diagnostics = messages(`${interpreter}
    export function leak(expression: SomeExpr) {
      return match expression { Some(tag, value) => value };
    }`);
  assert.ok(diagnostics.length > 0, "A hidden expression index escaped its match arm");
});

test("matching a user-defined type witness refines another field with the same hidden index", () => {
  const source = `${interpreter}
    data TypeWitness<T extends Ty> {
      IntegerType: TypeWitness<"int">,
      BooleanType: TypeWitness<"bool">,
      FunctionType: <A extends Ty, B extends Ty>(argument: TypeWitness<A>, result: TypeWitness<B>) => TypeWitness<Fun<A, B>>,
    }
    data TypedExpression {
      WithType: <T extends Ty>(witness: TypeWitness<T>, expression: Expr<T>) => TypedExpression,
    }
    function integerOnly(value: TypedExpression): bigint | undefined {
      return match value {
        WithType(witness, expression) => match witness {
          IntegerType => interp(expression),
          BooleanType => undefined,
          FunctionType(argument, result) => undefined
        }
      };
    }
    export const selectedInteger = integerOnly(WithType(IntegerType, Val(7n)));
    export const skippedBoolean = integerOnly(WithType(BooleanType, BoolVal(true)));
  `;
  const { program, outputs } = createProgram(source, options);
  assert.deepEqual(diagnosticMessages(program), []);
  const exports = {};
  vm.runInThisContext(`(function (exports, module) {\n${emitJavaScript(program, outputs)}\n})`)(exports, { exports });
  assert.equal(exports.selectedInteger, 7n);
  assert.equal(exports.skippedBoolean, undefined);
  assert.ok(messages(`${source}\nexport const invalidWitness = WithType(BooleanType, Val(7n));`).length > 0);
});

test("rich declarations preserve constructors, hidden indices, and type-family results across files", () => {
  const { program, outputs } = createProgram({ "/lib/index.tspp": interpreter }, { ...options, declaration: true, emitDeclarationOnly: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const declarations = [...outputs].find(([file]) => file.endsWith(".d.tspp"))?.[1];
  assert.ok(declarations, "No rich declarations were emitted");
  assert.match(declarations, /data Expr<T extends Ty>\s*\{/);
  assert.match(declarations, /Val:\s*\(value:\s*bigint\)\s*=>\s*Expr<"int">/);
  assert.match(declarations, /Some:\s*<T extends Ty>\(tag:\s*T,\s*expression:\s*Expr<T>\)\s*=>\s*SomeExpr/);
  const consumer = `
    import { App, BoolVal, choose, evaluateSome, Expr, Host, interp, Some, SomeValue, Val } from "./lib/index";
    export const answer: bigint = interp(Val(42n));
    export const boolean: boolean = interp(App(Host<"int", "bool">(n => n === 0n), Val(0n)));
    export const selected: SomeValue = evaluateSome(choose(true));
    export const repacked = match choose(false) { Some(tag, expression) => Some(tag, expression) };
  `;
  const files = { "/lib/index.d.tspp": declarations, "/main.tspp": consumer };
  assert.deepEqual(diagnosticMessages(createProgram(files, options).program), []);
  files["/main.tspp"] += '\nexport const wrong: Expr<"bool"> = Val(0n);';
  assert.ok(diagnosticMessages(createProgram(files, options).program).length > 0);
});

test("context indices and lambda result types survive rich declaration round trips", () => {
  const sources = { "/lib/10-gadt-interpreter.tspp": interpreter, "/lib/context.tspp": contextInterpreter };
  const { program, outputs } = createProgram(sources, { ...options, declaration: true, emitDeclarationOnly: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const files = Object.fromEntries([...outputs].filter(([file]) => file.endsWith(".d.tspp")));
  assert.equal(Object.keys(files).length, 2, "A dependency declaration was not emitted");
  files["/main.tspp"] = `
    import { add, factorial, interp, lookup, Nil, Stop } from "./lib/context";
    export const sum: bigint = interp(Nil, add)(20n)(22n);
    export const product: bigint = interp(Nil, factorial<readonly []>())(6n);
  `;
  assert.deepEqual(diagnosticMessages(createProgram(files, options).program), []);
  files["/main.tspp"] += '\nexport const invalidLookup = lookup(Stop<readonly [], "int">(), Nil);';
  assert.ok(diagnosticMessages(createProgram(files, options).program).length > 0);
});
