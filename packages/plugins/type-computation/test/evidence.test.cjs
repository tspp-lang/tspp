// Runtime type evidence: the trusted `Reified<T>`, types passed at run time as `(A: Type)`, and `typecase` on a
// descriptor whose type only the run time knows. Hidden types that `nominal-types` opens are covered by the integration
// tests (`runtime-evidence.test.cjs`).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { usePlugins, createProgram, diagnosticMessages, emitJavaScript } = require("../../test-support/compile.cjs");
const { typeComputationPlugin } = require("../dist");
usePlugins(typeComputationPlugin);

const options = { noLib: false, lib: ["lib.es2022.d.ts"], declaration: true };

function compile(source) {
  const { program, outputs } = createProgram({ "/main.tspp": source }, options);
  const messages = diagnosticMessages(program);
  const javascript = emitJavaScript(program, outputs);
  const declarations = [...outputs].filter(([fileName]) => fileName.endsWith(".d.ts")).map(([, text]) => text).join("\n");
  return { messages, javascript, declarations };
}

/** Runs the emitted CommonJS module and returns its exports, as plain data of this realm. */
function run(javascript) {
  const exports = {};
  vm.runInNewContext(javascript, { exports, module: { exports } });
  return JSON.parse(JSON.stringify(exports));
}

const show = `
  type Show = (A: Type, value: A) => string;
  export const show: Show = (A, value) => typecase A {
    number => value.toFixed(2),
    string => value.toUpperCase(),
    _ => "other"
  };`;

test("only a descriptor the compiler made is a Reified<T>", () => {
  assert.deepEqual(compile(`export const good: Reified<number> = reify number;`).messages, []);
  const forged = compile(`
    export const forged: Reified<number> = { kind: "type", text: "number", __tspp_reified_type: 1 as number };`).messages;
  assert.equal(forged.length, 1, forged.join("\n"));
  // A descriptor of "a" is no evidence that a type is any string.
  const widened = compile(`export const widened: Reified<string> = reify "a";`).messages;
  assert.equal(widened.length, 1, widened.join("\n"));
  // Its members stay readable, and the represented type stays reachable.
  assert.deepEqual(compile(`
    const d = reify number;
    export const text: string = d.text;
    export const value: number = null! as typeof d.__tspp_reified_type;`).messages, []);
});

test("a type passed at run time is inferred from its descriptor", () => {
  const { messages, declarations } = compile(`
    declare const pick: (A: Type) => A;
    export const n: number = pick(reify number);
    export const s: string = pick(reify string);`);
  assert.deepEqual(messages, []);
  assert.doesNotMatch(declarations, /Reified/);
});

test("a typecase on a passed type dispatches at run time and refines the value in each arm", () => {
  const { messages, javascript } = compile(`${show}
    export const results = [show(reify number, 1.5), show(reify string, "text"), show(reify boolean, true)];`);
  assert.deepEqual(messages, []);
  assert.deepEqual(run(javascript).results, ["1.50", "TEXT", "other"]);
});

test("each arm sees only its own pattern's members", () => {
  const messages = compile(`
    type Show = (A: Type, value: A) => string;
    export const show: Show = (A, value) => typecase A {
      number => value.toUpperCase(),
      string => value.toFixed(2),
      _ => "other"
    };`).messages;
  assert.equal(messages.length, 2, messages.join("\n"));
  assert.match(messages[0], /Property 'toUpperCase' does not exist on type 'A & number'/);
  assert.match(messages[1], /Property 'toFixed' does not exist on type 'A & string'/);
});

test("a matched pattern proves membership, not equality", () => {
  const messages = compile(`
    type Grow = (A: Type, value: A, list: A[]) => number;
    export const grow: Grow = (A, value, list) => typecase A {
      string => (list.push("added"), value.length),
      _ => 0
    };`).messages;
  // The value can be read as a string, but a string is not necessarily an A.
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /Argument of type 'string' is not assignable to parameter of type 'A & string'/);
  const literals = compile(`
    type Name = (A: Type) => string;
    export const name: Name = A => typecase A { "a" | "b" => "letter", string => "text", 1 => "one", _ => "other" };
    export const names = [name(reify "a"), name(reify "b" | "a"), name(reify "c"), name(reify string), name(reify 1), name(reify 1 | 2)];`);
  assert.deepEqual(literals.messages, []);
  // A union is covered only when the pattern covers all of it, as for assignability.
  assert.deepEqual(run(literals.javascript).names, ["letter", "letter", "text", "text", "one", "other"]);
});

test("run-time patterns are primitive and literal types", () => {
  const messages = compile(`
    type Inspect = (A: Type) => number;
    export const inspect: Inspect = A => typecase A { Array<infer E> => 1, { x: number } => 2, _ => 0 };`).messages;
  assert.equal(messages.length, 2, messages.join("\n"));
  assert.match(messages[0], /'infer' needs the described type at compile time/);
  assert.match(messages[1], /only primitive types, literal types, and their unions/);
});

test("a dynamic typecase evaluates its descriptor once, and only the arm that matched", () => {
  const { messages, javascript } = compile(`
    export const log: string[] = [];
    type Pick = (A: Type) => string;
    const pick: Pick = A => typecase (log.push("descriptor"), A) {
      number => (log.push("number"), "n"),
      _ => (log.push("other"), "o")
    };
    export const picked = pick(reify number);`);
  assert.deepEqual(messages, []);
  const exports = run(javascript);
  assert.equal(exports.picked, "n");
  assert.deepEqual(exports.log, ["descriptor", "number"]);
});

test("reify needs a type known at compile time", () => {
  const messages = compile(`export function describe<T>() { return reify T[]; }`).messages;
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /'reify' needs a type known at compile time/);
});

test("declaration output keeps evidence trusted for TS++ and plain for TypeScript", () => {
  const { program, outputs } = createProgram({ "/main.tspp": `
    export const descriptor = reify string;
    export type Show = (A: Type, value: A) => string;` }, options);
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const rich = outputs.get("/main.d.tspp");
  const compatible = outputs.get("/main.d.ts");
  assert.match(rich, /export declare const descriptor: Reified<string>;/);
  assert.match(rich, /export type Show = \(A: Type, value: A\) => string;/);
  assert.doesNotMatch(compatible, /Reified|Type,/);
  assert.match(compatible, /export type Show = <A>\(A: \{\s*kind: "type";\s*text: string;\s*__tspp_reified_type: A;\s*\}, value: A\) => string;/);
});
