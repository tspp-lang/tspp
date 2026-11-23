// `class C extends A, B`: the checker sees every base through a typed constant and a merged interface, and each class
// used as an additional base is emitted as a factory of copies that share its private state, statics, and `instanceof`.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { advancedClassesPlugin } = require("../dist");

usePlugins(advancedClassesPlugin);

function compile(files, options = {}) {
  const sources = typeof files === "string" ? { "/main.tspp": files } : files;
  const { program, outputs } = createProgram(sources, { noLib: false, ...options });
  const messages = diagnosticMessages(program);
  return {
    program,
    messages,
    codes: [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(diagnostic => diagnostic.code),
    outputs: () => {
      program.emit();
      return outputs;
    },
    /** Runs the CommonJS output and returns the exports of `/main`. */
    run: () => {
      program.emit();
      const modules = new Map();
      const load = name => {
        if (modules.has(name)) return modules.get(name).exports;
        const module = { exports: {} };
        modules.set(name, module);
        const text = outputs.get(`${name}.js`);
        if (text === undefined) throw new Error(`No output for ${name}`);
        new Function("exports", "require", "module", text)(module.exports, request => load(request.replace(/^\.\//, "/")), module);
        return module.exports;
      };
      return load("/main");
    },
  };
}

const named = `
  export class Named {
    #label = "unnamed";
    static created = 0;
    constructor() { Named.created++; }
    get label(): string { return this.#label; }
    rename(label: string): this { this.#label = label; return this; }
    sameLabel(other: Named): boolean { return this.#label === other.#label; }
    static isNamed(value: object): boolean { return #label in value; }
  }
`;

test("a class inherits from every base, and a copy shares private state, statics, and instanceof", () => {
  const result = compile({
    "/named.tspp": named,
    "/main.tspp": `
      import { Named } from "./named";
      class Point {
        constructor(public x: number, public y: number) {}
        sum(): number { return this.x + this.y; }
      }
      export class Landmark extends Point, Named {
        describe(): string { return this.label + "@" + this.sum(); }
      }
      const landmark = new Landmark(3, 4).rename("tower");
      const plain = new Named().rename("tower");
      export const result = {
        describe: landmark.describe(),
        isPoint: landmark instanceof Point,
        isNamed: landmark instanceof Named,
        isLandmark: landmark instanceof Landmark,
        plainIsLandmark: plain instanceof Landmark,
        brand: Named.isNamed(landmark),
        same: plain.sameLabel(landmark),
        created: Named.created,
        copyCreated: Landmark.created,
      };
      Landmark.created = 10;
      export const afterWrite = Named.created;
    `,
  });
  assert.deepEqual(result.messages, []);
  const exports = result.run();
  assert.deepEqual(exports.result, {
    describe: "tower@7",
    isPoint: true,
    isNamed: true,
    isLandmark: true,
    plainIsLandmark: false,
    brand: true,
    same: true,
    created: 2,
    copyCreated: 2,
  });
  assert.equal(exports.afterWrite, 10);
});

test("the checker sees the members of every base, and still rejects members no base has", () => {
  const result = compile(`
    class Point { x = 1; }
    class Tagged { tag(): string { return "t"; } }
    class Tagged2 extends Point, Tagged {}
    const value = new Tagged2();
    const x: number = value.x;
    const tag: string = value.tag();
    const asTagged: Tagged = value;
    value.missing;
  `);
  assert.deepEqual(result.messages, ["Property 'missing' does not exist on type 'Tagged2'."]);
});

test("generic bases take their type arguments", () => {
  const result = compile(`
    class Holder<T> { constructor(public value: T) {} get(): T { return this.value; } }
    class Labeled<L> { label?: L; setLabel(label: L): this { this.label = label; return this; } }
    export class Box<T, L = string> extends Holder<T>, Labeled<L> {}
    const box = new Box<number>(41).setLabel("answer");
    const value: number = box.get() + 1;
    const label: string | undefined = box.label;
    export const result = [value, label];
  `);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.run().result, [42, "answer"]);
});

test("three bases apply in order and pass constructor arguments to the first", () => {
  const result = compile(`
    class Base { constructor(public id: number) {} }
    class Left { left = "l"; describeLeft(): string { return "left"; } }
    class Right { right = "r"; describeRight(): string { return "right"; } }
    class Both extends Base, Left, Right {}
    const both = new Both(7);
    export const result = [both.id, both.left, both.right, both.describeLeft(), both.describeRight(), both instanceof Left, both instanceof Right];
  `);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.run().result, [7, "l", "r", "left", "right", true, true]);
});

test("private fields, methods, and brand checks work on copies", () => {
  const result = compile(`
    class Root {}
    class Counter {
      #count = 0;
      #step = 1;
      label = "count";
      #bump(by: number): number { this.#count += by * this.#step; return this.#count; }
      next(): number { return this.#bump(1); }
      postfix(): number { return this.#count++; }
      prefix(): number { return --this.#count; }
      orDefault(): number { this.#step ??= 5; this.#step ||= 9; return this.#step; }
      copyFrom(other: Counter): number { this.#count = other.#count; return this.#count; }
      static has(value: object): boolean { return #count in value && #bump in value; }
      viaReceiver(make: () => Counter): number { return make().#bump(10); }
    }
    class Ticker extends Root, Counter {}
    const ticker = new Ticker();
    const first = ticker.next();
    const post = ticker.postfix();
    const pre = ticker.prefix();
    const plain = new Counter();
    plain.next(); plain.next(); plain.next();
    export const result = {
      first, post, pre,
      step: ticker.orDefault(),
      copied: ticker.copyFrom(plain),
      has: [Counter.has(ticker), Counter.has(plain), Counter.has({})],
      receiver: ticker.viaReceiver(() => ticker),
      label: ticker.label,
    };
  `);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.run().result, {
    first: 1,
    post: 1,
    pre: 1,
    step: 1,
    copied: 3,
    has: [true, true, false],
    receiver: 13,
    label: "count",
  });
});

test("fields keep their order around private fields, and static methods see the copy as 'this'", () => {
  const result = compile(`
    class Root {}
    class Ordered {
      first = 1;
      #second = this.first + 1;
      third = this.#second + 1;
      static kind = "ordered";
      static make<T>(this: new () => T): T { return new this(); }
      get values(): number[] { return [this.first, this.#second, this.third]; }
    }
    class Child extends Root, Ordered {}
    const made = Child.make();
    export const result = [made.values, made instanceof Child, Child.kind];
  `);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.run().result, [[1, 2, 3], true, "ordered"]);
});

test("a class without private state keeps its fields, with useDefineForClassFields either way", () => {
  for (const useDefineForClassFields of [true, false]) {
    const result = compile(`
      class Root {}
      class Plain { a = 1; b?: number; static count = 3; static { Plain.count++; } }
      class Mixed extends Root, Plain {}
      const mixed = new Mixed();
      export const result = [mixed.a, "b" in mixed, Plain.count, Mixed.count];
    `, { useDefineForClassFields });
    assert.deepEqual(result.messages, []);
    assert.deepEqual(result.run().result, [1, useDefineForClassFields, 4, 4]);
  }
});

test("the same member from two bases is an error, even where the class declares it too", () => {
  const result = compile(`
    class Left { name = "left"; static create(): Left { return new Left(); } }
    class Right { name = "right"; static create(): Right { return new Right(); } }
    class Both extends Left, Right { name = "both"; }
  `);
  assert.deepEqual(result.messages, [
    "Member 'name' is inherited from both 'Left' and 'Right'.",
    "Static member 'create' is inherited from both 'Left' and 'Right'.",
  ]);
});

test("members the first base inherits conflict too, and private names never do", () => {
  const result = compile(`
    class Ancestor { shared(): number { return 1; } }
    class First extends Ancestor { #own = 1; }
    class Extra { #own = 2; shared(): number { return 2; } }
    class Child extends First, Extra {}
  `);
  assert.deepEqual(result.messages, ["Member 'shared' is inherited from both 'First' and 'Extra'."]);
});

test("abstract members of an additional base must be implemented", () => {
  const source = body => `
    class Root {}
    abstract class Shape { abstract area(): number; describe(): string { return "area " + this.area(); } }
    ${body}
  `;
  assert.deepEqual(compile(source("class Square extends Root, Shape {}")).messages, [
    "Non-abstract class 'Square' does not implement abstract member 'area' inherited from 'Shape'.",
  ]);
  assert.deepEqual(compile(source("abstract class Square extends Root, Shape {}")).messages, []);
  const implemented = compile(source(`
    class Square extends Root, Shape { area(): number { return 4; } }
    export const result = new Square().describe();
  `));
  assert.deepEqual(implemented.messages, []);
  assert.equal(implemented.run().result, "area 4");
});

test("an additional base must be a class the emitted program can copy", () => {
  const cases = {
    "it is not a class": "const Value = class {}; class C extends Root, Value {}",
    "it extends another class": "class Parent {} class Child extends Parent {} class C extends Root, Child {}",
    "its constructor takes parameters": "class Takes { constructor(value: number) {} } class C extends Root, Takes {}",
    "it has a static private member": "class Hidden { static #count = 0; } class C extends Root, Hidden {}",
    "it has a private accessor": "class Hidden { get #value(): number { return 1; } } class C extends Root, Hidden {}",
    "it reads a private member through optional chaining": "class Hidden { #value = 1; read(other?: Hidden) { return other?.#value; } } class C extends Root, Hidden {}",
    "it assigns a private member by destructuring": "class Hidden { #value = 1; fill(values: number[]) { [this.#value] = values; } } class C extends Root, Hidden {}",
    "it must be declared at the top level of its file": "namespace Inner { export class Nested {} } class C extends Root, Inner.Nested {}",
  };
  for (const [problem, body] of Object.entries(cases)) {
    const result = compile(`class Root {} ${body}`);
    assert(result.messages.some(message => message.endsWith(`cannot be an additional base: ${problem}.`)), `${problem}: ${result.messages.join("\n")}`);
  }
});

test("an additional base must be declared in a .tspp source file of this compilation", () => {
  const fromTypeScript = compile({
    "/plain.ts": "export class Plain { value = 1; }",
    "/main.tspp": "import { Plain } from './plain'; class Root {} class C extends Root, Plain {}",
  });
  assert.deepEqual(fromTypeScript.messages, ["'Plain' cannot be an additional base: it must be declared in a .tspp source file of this compilation."]);

  const fromDeclaration = compile({
    "/declared.d.ts": "export declare class Declared { value: number; }",
    "/main.tspp": "import { Declared } from './declared'; class Root {} class C extends Root, Declared {}",
  });
  assert.deepEqual(fromDeclaration.messages, ["'Declared' cannot be an additional base: it must be declared in a .tspp source file of this compilation."]);
});

test("a base listed twice, final and sealed bases, and final members are reported where they are written", () => {
  assert.deepEqual(compile("class Root {} class Extra {} class C extends Root, Extra, Extra {}").messages, ["'Extra' is listed as a base more than once."]);
  assert.deepEqual(compile("class Root {} final class Closed {} class C extends Root, Closed {}").messages, ["Cannot inherit from final class 'Closed'."]);
  assert.deepEqual(compile("final class Closed {} class Extra {} class C extends Closed, Extra {}").messages, ["Cannot inherit from final class 'Closed'."]);
  assert.deepEqual(compile("class Root {} class Kept { final kept(): number { return 1; } } class C extends Root, Kept { kept(): number { return 2; } }").messages, [
    "Cannot override final member 'kept' of class 'Kept'.",
  ]);

  const sealed = compile({
    "/family.tspp": "export sealed class Family { m(): number { return 1; } }",
    "/main.tspp": "import { Family } from './family'; class Root {} class C extends Root, Family {}",
  });
  assert.deepEqual(sealed.messages, ["Cannot extend sealed class 'Family' outside of its declaring file."]);

  const result = compile("class Root {} final class Closed {} class C extends Root, Closed {}");
  const diagnostic = result.program.getSemanticDiagnostics().find(item => item.code === 19101);
  assert.equal(diagnostic.file.text.slice(diagnostic.start, diagnostic.start + diagnostic.length), "Closed");
});

test("each base must be a name, and the class must have one", () => {
  const call = compile("function make() { return class {}; } class Root {} class C extends Root, make() {}");
  assert(call.messages.includes("A class with more than one base must name each base, such as 'Base' or 'module.Base'."), call.messages.join("\n"));
  const anonymous = compile("class Root {} class Extra {} export default class extends Root, Extra {}");
  assert(anonymous.messages.includes("A class with more than one base must have a name."), anonymous.messages.join("\n"));
});

test("an exported default class with several bases, and bases from a namespace import", () => {
  const result = compile({
    "/bases.tspp": "export class Root { root = 1; } export class Extra { extra = 2; }",
    "/child.tspp": "import * as bases from './bases'; export default class Child extends bases.Root, bases.Extra {}",
    "/main.tspp": "import Child from './child'; const child = new Child(); export const result = [child.root, child.extra];",
  });
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.run().result, [1, 2]);
});

test("a data class can have several bases", () => {
  const result = compile(`
    class Root {}
    class Greeter { greet(): string { return "hi"; } }
    data class Person(name: string) extends Root, Greeter;
    const person = new Person("Ada");
    export const result = [person.name, person.greet(), person.copy({ name: "Grace" }).name];
  `);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.run().result, ["Ada", "hi", "Grace"]);
});

test("a class compiled before it was used as an additional base fails with a clear error", () => {
  // The file of the additional base comes from an earlier build in which no class used it.
  const earlier = compile({ "/named.tspp": named, "/main.tspp": "export {};" }).outputs().get("/named.js");
  const result = compile({ "/named.tspp": named, "/main.tspp": "import { Named } from './named'; class Root {} export class C extends Root, Named {}" });
  const outputs = result.outputs();
  outputs.set("/named.js", earlier);
  const modules = new Map();
  const load = name => {
    if (modules.has(name)) return modules.get(name).exports;
    const module = { exports: {} };
    modules.set(name, module);
    new Function("exports", "require", "module", outputs.get(`${name}.js`))(module.exports, request => load(request.replace(/^\.\//, "/")), module);
    return module.exports;
  };
  assert.throws(() => load("/main"), /'Named' cannot be used as an additional base of 'C': it was compiled before this use/);
});

test("a class nobody uses as an additional base is emitted as it is", () => {
  const source = "export class Named { #label = 'x'; get label() { return this.#label; } }";
  const alone = compile({ "/named.tspp": source, "/main.tspp": "export {};" }).outputs().get("/named.js");
  const withOther = compile({ "/named.tspp": source, "/main.tspp": "class Root {} class Extra {} export class C extends Root, Extra {}" }).outputs().get("/named.js");
  assert.equal(withOther, alone);
  assert.match(alone, /#label/);
});

test("declaration output describes every base for projects without the plugin", () => {
  const result = compile({
    "/named.tspp": named,
    "/main.tspp": "import { Named } from './named'; export class Point { x = 0; } export class Landmark extends Point, Named {}",
  }, { declaration: true });
  assert.deepEqual(result.messages, []);
  const declarations = result.outputs().get("/main.d.ts");
  assert.match(declarations, /declare const Landmark_base: typeof Point & \{/);
  assert.match(declarations, /export declare class Landmark extends Landmark_base/);
  assert.match(declarations, /export interface Landmark extends Named/);

  const consumer = compile({
    "/named.d.ts": result.outputs().get("/named.d.ts"),
    "/landmark.d.ts": declarations,
    "/consumer.ts": `
      import { Landmark } from "./landmark";
      import { Named } from "./named";
      declare const landmark: Landmark;
      const x: number = landmark.x;
      const asNamed: Named = landmark;
      export class Further extends Landmark { extra = 1; }
    `,
  }, { noLib: false });
  assert.deepEqual(consumer.messages, []);
});

test("commas inside type parameters are not a second base", () => {
  // The scan for a second base counts brackets, and ends at the class body.
  const result = compile(`
    class Root {}
    class Extra { extra = 1; }
    class Single extends Root { values = [1, 2]; }
    class Generic<T extends { a: number, b: string }> extends Root, Extra {}
    const generic = new Generic<{ a: number, b: string }>();
    export const result = [new Single().values.length, generic.extra];
  `);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.run().result, [2, 1]);
});

test("TypeScript files keep their own error for several bases", () => {
  const result = compile({ "/main.ts": "class A {} class B {} class C extends A, B {}" });
  assert(result.codes.includes(1174), result.messages.join("\n"));
});



test("editor services read the class's own words, not the declarations it lowers to", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const source = "class A { a = 1; }\nclass B { b = 2; }\nexport default class C extends A, B {\n  m() { return `${this.a}` + this.b; }\n}\n";
  const service = createLanguageService("/main.tspp", source);
  const quickInfo = position => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", position)?.displayParts ?? []);
  assert.equal(quickInfo(source.indexOf("${this") + 2), "this: this");
  assert.equal(quickInfo(source.indexOf("extends A") + 8), "class A");
  assert.equal(quickInfo(source.indexOf(", B") + 2), "class B");
  assert.equal(quickInfo(source.indexOf("class C") + 6), "class C");
  assert.doesNotThrow(() => service.getOutliningSpans("/main.tspp"));
});

test("an error the merged interface reports is reported at the class's name", () => {
  const result = compile("class Root {}\nclass Extra { extra = 2; }\nclass Child extends Root, Extra { extra = 'two'; }\n");
  const diagnostics = result.program.getSemanticDiagnostics();
  assert.equal(diagnostics.length, 1, result.messages.join("\n"));
  const [diagnostic] = diagnostics;
  assert.match(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"), /Interface 'Child' incorrectly extends interface 'Extra'/);
  assert.equal(diagnostic.file.text.slice(diagnostic.start, diagnostic.start + diagnostic.length), "Child");
});
