// Runtime type evidence across plugins: a `data` constructor that keeps a type at run time, as `(A: Type, value: A)`,
// hides that type like any constructor type parameter, and `typecase` on the descriptor a `match` binds recovers it.
// A value index such as a length is the value itself, which an arm may return as its constraint.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { ts, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const options = { noLib: false, lib: ["lib.es2022.d.ts"], declaration: true };

function compile(source) {
  const { program, outputs } = createProgram({ "/main.tspp": source }, options);
  return { program, outputs, messages: diagnosticMessages(program), javascript: emitJavaScript(program, outputs) };
}

/** Runs the emitted CommonJS module and returns its exports, as plain data of this realm. */
function run(javascript) {
  const exports = {};
  vm.runInNewContext(javascript, { exports, module: { exports } });
  return JSON.parse(JSON.stringify(exports));
}

test("a data constructor can keep a type at run time, and a match recovers it", () => {
  const source = `
    data AnyValue { Pack: (A: Type, value: A) => AnyValue }
    data HList {
      Nil: HList,
      Cons: (head: AnyValue, tail: HList) => HList
    }
    const values: HList = Cons(Pack(reify number, 1), Cons(Pack(reify string, "x"), Cons(Pack(reify boolean, false), Nil)));
    function describe(item: AnyValue): string {
      return match item {
        Pack(A, value) => typecase A {
          number => "num: " + value.toFixed(2),
          string => "str: " + value.toUpperCase(),
          _ => "other"
        }
      };
    }
    function all(list: HList): string[] {
      return match list { Nil => [], Cons(head, tail) => [describe(head), ...all(tail)] };
    }
    export const described = all(values);`;
  const { messages, javascript } = compile(source);
  assert.deepEqual(messages, []);
  assert.deepEqual(run(javascript).described, ["num: 1.00", "str: X", "other"]);
  // The descriptor and the value must agree, and two packs' hidden types are unrelated.
  const mismatch = compile(`
    data AnyValue { Pack: (A: Type, value: A) => AnyValue }
    export const bad = Pack(reify number, "x");`).messages;
  assert.equal(mismatch.length, 1, mismatch.join("\n"));
  const mixed = compile(`
    data AnyValue { Pack: (A: Type, value: A) => AnyValue }
    declare const first: AnyValue;
    declare const second: AnyValue;
    export const mixed = match first { Pack(A, a) => match second { Pack(B, b) => Pack(A, b) } };`).messages;
  assert.equal(mixed.length, 1, mixed.join("\n"));
  // The hidden value itself cannot leave its arm.
  assert.ok(compile(`
    data AnyValue { Pack: (A: Type, value: A) => AnyValue }
    declare const item: AnyValue;
    export const leak = match item { Pack(A, value) => value };`).messages.some(message => /hidden constructor type escapes/.test(message)));
});

test("a value index can be returned from its arm as its constraint", () => {
  const { messages, javascript } = compile(`
    type Vec<T, N extends number, Items extends T[] = []> = Items["length"] extends N ? Items : Vec<T, N, [...Items, T]>;
    data Sized { Sized: (length: Nat, items: Vec<number, length>) => Sized }
    const sized: Sized = Sized(3, [1, 2, 3]);
    export const length = match sized { Sized(length, items) => length };
    export const checked: number = length;`);
  assert.deepEqual(messages, []);
  assert.equal(run(javascript).length, 3);
  assert.equal(compile(`
    type Vec<T, N extends number, Items extends T[] = []> = Items["length"] extends N ? Items : Vec<T, N, [...Items, T]>;
    data Sized { Sized: (length: Nat, items: Vec<number, length>) => Sized }
    export const bad = Sized(2, [1, 2, 3]);`).messages.length, 1);
});


test("declaration output keeps a constructor's run-time type as written", () => {
  const { program, outputs, messages } = compile(`export data AnyValue { Pack: (A: Type, value: A) => AnyValue }`);
  assert.deepEqual(messages, []);
  program.emit();
  assert.match(outputs.get("/main.d.tspp"), /export data AnyValue \{ Pack: \(A: Type, value: A\) => AnyValue \}/);
  assert.doesNotMatch(outputs.get("/main.d.ts"), /Type,|Reified/);
});

test("a value refined by its descriptor leaves its arm as the pattern's type", () => {
  const { messages, javascript } = compile(`
    data AnyValue { Pack: (A: Type, value: A) => AnyValue }
    const items = [Pack(reify number, 2), Pack(reify string, "x"), Pack(reify number, 3)];
    export const numbers = items.map(item => match item { Pack(A, value) => typecase A { number => value, _ => 0 } });
    export const doubled: number[] = numbers.map(n => n * 2);`);
  assert.deepEqual(messages, []);
  assert.deepEqual(run(javascript).doubled, [4, 0, 6]);
  // Nested in a type, the refined value is still that known type; unrefined, as in the `_` arm, it says nothing.
  assert.deepEqual(compile(`
    data AnyValue { Pack: (A: Type, value: A) => AnyValue }
    declare const item: AnyValue;
    export const wrapped: number[] = match item { Pack(A, value) => typecase A { number => [value], _ => [] } };`).messages, []);
  assert.ok(compile(`
    data AnyValue { Pack: (A: Type, value: A) => AnyValue }
    declare const item: AnyValue;
    export const leak = match item { Pack(A, value) => typecase A { number => value, _ => value } };`).messages
    .some(message => /hidden constructor type escapes/.test(message)));
});

test("editor requests read lowered constructor types and unfinished calls", () => {
  const source = `export data AnyValue { Pack: (A: Type, value: A) => AnyValue }
export data Sized { Sized: (length: Nat, items: number[]) => Sized }
type Show = (A: Type, value: A) => string;
export const show: Show = (`;
  const service = createLanguageService("/main.tspp", source, options);
  // A field of a lowered constructor has a generated name, and the property for it still has a position.
  assert.ok(service.getEncodedSemanticClassifications("/main.tspp", { start: 0, length: source.length }, ts.SemanticClassificationFormat.TwentyTwenty));
  // After a trailing `(`, the parser's missing expression is a child that signature help can find.
  service.getSignatureHelpItems("/main.tspp", source.length, undefined);
});

test("editors read the dependent signature of a data constructor as type-level syntax", () => {
  const source = `type Vec<T, N extends number> = T[];
export data AnyValue { Pack: (A: Type, value: A) => AnyValue }
export data Sized { Sized: (length: Nat, items: Vec<string, length>) => Sized }
`;
  const service = createLanguageService("/main.tspp", source, options);
  const hover = position => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", position)?.displayParts ?? []);
  // Data syntax keeps only the parameters of the signature, which still belong to the plugin that parsed it.
  assert.equal(hover(source.indexOf("A) => AnyValue")), "(type-level name) A");
  assert.equal(hover(source.indexOf("length>")), "(type-level name) length");
  const spans = service.getEncodedSemanticClassifications("/main.tspp", { start: 0, length: source.length }, ts.SemanticClassificationFormat.TwentyTwenty).spans;
  const classOf = position => {
    for (let index = 0; index < spans.length; index += 3) if (spans[index] === position) return (spans[index + 2] >> 8) - 1;
    return undefined;
  };
  const [typeParameter, type] = [4, 5];
  assert.equal(classOf(source.indexOf("A) => AnyValue")), typeParameter);
  // A type the file declares is a type there, not a binder.
  assert.equal(classOf(source.indexOf("AnyValue }")), type);
  assert.equal(classOf(source.indexOf("Vec<string")), type);
});
