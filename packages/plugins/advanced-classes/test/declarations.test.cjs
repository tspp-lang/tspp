// What a project reading `.d.tspp` gets. Plugin state lives as long as the process, so each side has one of its own, as
// two projects built apart do.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");

const worker = `
const support = ${JSON.stringify(path.resolve(__dirname, "../../test-support/compile.cjs"))};
const { usePlugins, createProgram, diagnosticMessages } = require(support);
usePlugins(require(${JSON.stringify(path.resolve(__dirname, "../dist"))}).default);
const input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
const { program, outputs } = createProgram(input.files, input.options);
const messages = diagnosticMessages(program);
program.emit();
console.log(JSON.stringify({ messages, outputs: Object.fromEntries(outputs) }));
`;

function run(files, options) {
  return JSON.parse(execFileSync(process.execPath, ["--max-old-space-size=1024", "-e", worker], { input: JSON.stringify({ files, options }), encoding: "utf8" }));
}

const library = `
  export final class Closed<T> { constructor(readonly value: T) {} get(): T { return this.value; } }
  export sealed class Family { m(): number { return 1; } }
  export class Member extends Family {}
  export class Locked { final kept(): number { return 1; } other(): number { return 2; } }
  export abstract class Plain { abstract m(): number; }
  export data class Point(x: number, y: string);
  export final class Shapes {
    label?: string;
    constructor(readonly size: number, extra?: string) {}
    get area(): number { return 1; }
    set area(value: number) {}
    pick<T>(item: T, index?: number, ...rest: T[]): T { return item; }
    final kept<U>(value: U): U { return value; }
  }
`;
const declarations = () => {
  const { messages, outputs } = run({ "/lib/index.tspp": library }, { declaration: true, emitDeclarationOnly: true });
  assert.deepEqual(messages, []);
  return outputs;
};
const consumer = (text, body) => run({
  "/lib/index.d.tspp": text,
  "/main.tspp": `import { Closed, Family, Locked, Plain, Point } from "./lib/index"; void [Closed, Family, Locked, Plain, Point]; ${body}`,
}, { noEmit: true }).messages;

test(".d.tspp keeps class and member modifiers, and the members", () => {
  const text = declarations()["/lib/index.d.tspp"];
  assert.match(text, /export declare final class Closed<T> \{/);
  assert.match(text, /get\(\): T;/);
  assert.match(text, /export declare sealed class Family \{/);
  assert.match(text, /final kept\(\): number;/);
  assert.doesNotMatch(text, /final other/);
  assert.match(text, /export declare abstract class Plain/);
});

test("the compatible .d.ts stays plain TypeScript", () => {
  const text = declarations()["/lib/index.d.ts"];
  assert.doesNotMatch(text, /\b(final|sealed)\b/);
  assert.match(text, /export declare class Closed<T>/);
});

test("members of every shape survive being read back", () => {
  const text = declarations()["/lib/index.d.tspp"];
  assert.match(text, /final kept<U>\(value: U\): U;/);
  assert.deepEqual(consumer(text, `export const s = new Shapes(1, "x"); export const a: number = s.area; export const p: string = s.pick("x", 0); export const k: number = s.kept(1);`.replace("export const s", 'import { Shapes } from "./lib/index"; export const s')), []);
});

test("a project reading the declarations keeps the rules", () => {
  const text = declarations()["/lib/index.d.tspp"];
  assert.deepEqual(consumer(text, `export const value: number = new Closed(1).get(); export const point = new Point(1, "x").copy({ x: 2 });`), []);
  assert.match(consumer(text, `class Sub extends Closed<number> {}`).join(), /Cannot inherit from final class 'Closed'/);
  assert.match(consumer(text, `class Sub extends Family {}`).join(), /Cannot extend sealed class 'Family'/);
  assert.match(consumer(text, `class Sub extends Locked { kept(): number { return 2; } }`).join(), /Cannot override final member 'kept'/);
  assert.deepEqual(consumer(text, `class Sub extends Locked { other(): number { return 3; } }`), []);
});
