// Runtime type evidence: the trusted `Reified<T>`, types passed at run time as `(A: Type)`, and `typecase` on a
// descriptor whose type only the run time knows. Hidden types that `nominal-types` opens are covered by the integration
// tests (`runtime-evidence.test.cjs`).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { ts, usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
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

test("editors describe the types a signature takes, and evidence by its type", () => {
  const source = `type Describe = (A: Type, value: A) => string;
export const describe: Describe = (A, value) => typecase A { number => "number", _ => "other" };
export const evidence: Reified<number> = reify number;
`;
  const service = createLanguageService("/main.tspp", source, options);
  const hover = position => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", position)?.displayParts ?? []);
  // The signature lowers to generated nodes, and its binder is still the plugin's to describe.
  assert.equal(hover(source.indexOf("A) =>")), "(type-level name) A");
  assert.equal(hover(source.indexOf("A, value)")), "(parameter) A: Reified<A>");
  assert.equal(hover(source.indexOf("Reified")), "type Reified<T>");
  const spans = service.getEncodedSemanticClassifications("/main.tspp", { start: 0, length: source.length }, ts.SemanticClassificationFormat.TwentyTwenty).spans;
  const classOf = position => {
    for (let index = 0; index < spans.length; index += 3) if (spans[index] === position) return (spans[index + 2] >> 8) - 1;
    return undefined;
  };
  const typeParameter = 4;
  assert.equal(classOf(source.indexOf("A) =>")), typeParameter);
});

test("declarations show what was written, and uses show the evidence they take", () => {
  const source = `export type Describe = (A: Type, value: A) => string;
export const describe: Describe = (A, value) => "";
export const described = describe(reify number, 1);
export const both: Reified<number> & { tag: 1 } = null!;
export function direct(A: Type, value: A): string { return ""; }
`;
  const service = createLanguageService("/main.tspp", source, options);
  const hover = position => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", position)?.displayParts ?? []);
  assert.equal(hover(source.indexOf("Describe")), "type Describe = (A: Type, value: A) => string");
  const help = service.getSignatureHelpItems("/main.tspp", source.indexOf("reify number, 1"), undefined).items[0];
  assert.deepEqual(help.parameters.map(parameter => ts.displayPartsToString(parameter.displayParts)), ["A: Reified<number>", "value: number"]);
  assert.equal(hover(source.indexOf("direct")), "function direct(A: Type, value: A): string");
  // Only the descriptor's own members fold into Reified<T>.
  assert.match(hover(source.indexOf("both")), /Reified<number> & \{\s*tag: 1;\s*\}/);
});

test("Reified is a type like the ones around it", () => {
  const { messages } = compile(`
    declare const left: Reified<number> & { tag: 1 };
    declare const right: { tag: 1 } & Reified<number>;
    declare const either: Reified<number> | Reified<string>;
    declare const many: Reified<number>[];
    export const tags: 1[] = [left.tag, right.tag];
    export const text: string = either.text;
    export const first: Reified<number> = many[0];`);
  assert.deepEqual(messages, []);
  // An operand is evidence only as the compiler made it.
  const forged = compile(`export const forged: { tag: 1 } & Reified<number> = { tag: 1, kind: "type", text: "number", __tspp_reified_type: 1 as number };`).messages;
  assert.equal(forged.length, 1, forged.join("\n"));
});

test("an alias hover shows only that alias, whatever follows it", () => {
  const source = `export type Identity = <T> =>> T;
export type Describe = (A: Type, value: A) => string;
`;
  const service = createLanguageService("/main.tspp", source, options);
  const hover = position => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", position)?.displayParts ?? []);
  assert.doesNotMatch(hover(source.indexOf("Identity")), /Describe/);
  assert.equal(hover(source.indexOf("Describe")), "type Describe = (A: Type, value: A) => string");
});
