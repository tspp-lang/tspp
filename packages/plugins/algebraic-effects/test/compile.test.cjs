// End-to-end behavior: what compiles, what is reported, and what the emitted JavaScript computes.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { algebraicEffectsPlugin } = require("../dist");

usePlugins(algebraicEffectsPlugin);

const prelude = `
effect Logger { info(message: string): void; }
effect Config { get(key: string): string; }
effect State<S> { get(): S; set(value: S): void; }
`;

const withLib = options => ({ noLib: false, ...options });
const messages = (source, options) => diagnosticMessages(createProgram(source, withLib(options)).program);

/** Compiles `files`, requires no errors, and returns the exports of `/main.js` when it runs. */
function run(files, options) {
  const sources = typeof files === "string" ? { "/main.tspp": files } : files;
  const { program, outputs } = createProgram(sources, withLib(options));
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const loaded = new Map();
  const load = fileName => {
    if (loaded.has(fileName)) return loaded.get(fileName).exports;
    const module = { exports: {} };
    loaded.set(fileName, module);
    vm.runInNewContext(outputs.get(fileName), {
      module,
      exports: module.exports,
      require: specifier => load(`/${specifier.replace(/^\.\//, "").replace(/\.tspp$/, "")}.js`),
    });
    return module.exports;
  };
  return { exports: load("/main.js"), outputs };
}

test("handles an effect and passes the capability first", () => {
  const { exports, outputs } = run(`${prelude}
    const lines: string[] = [];
    function greet(name: string) / Logger: string {
      perform Logger.info("hi " + name);
      return "Hello " + name;
    }
    export const result = handle Logger { info: message => { lines.push(message); } } in { greet("Ada") };
    export const logged = lines;
  `);
  assert.equal(exports.result, "Hello Ada");
  assert.deepEqual([...exports.logged], ["hi Ada"]);
  const js = outputs.get("/main.js");
  assert.match(js, /function greet\(\$effects(_\d+)?, name\)/);
  assert.match(js, /\$effects(_\d+)?\.Logger\.info\(/);
  assert.doesNotMatch(js, /null|__tspp/);
});

test("the effect leaves no JavaScript, and a program without effects is untouched", () => {
  const { outputs } = run(`${prelude}
    export function plain(a: number) { return a + 1; }
  `);
  assert.doesNotMatch(outputs.get("/main.js"), /Logger|effects/);
  assert.match(outputs.get("/main.js"), /function plain\(a\)/);
});

test("chained handlers reach a function requiring both, without a new object per call", () => {
  const { exports, outputs } = run(`${prelude}
    const lines: string[] = [];
    function calculate(id: string) / { Logger, Config }: number {
      perform Logger.info(id);
      return Number(perform Config.get("rate")) * 2;
    }
    export const total = handle Config {
      get: key => key === "rate" ? "21" : "0",
    } in handle Logger {
      info(message) { lines.push(message); },
    } in {
      calculate("order");
    };
    export const logged = lines;
  `);
  assert.equal(exports.total, 42);
  assert.deepEqual([...exports.logged], ["order"]);
  assert.match(outputs.get("/main.js"), /calculate\(\$effects(_\d+)?, "order"\)/);
});

test("the return clause maps the value and sets the type", () => {
  const { exports } = run(`${prelude}
    function value() / Logger: number { return 20; }
    export const mapped: { some: number } = handle Logger {
      info: () => {},
      return: v => ({ some: v + 1 }),
    } in { value() };
    export const method = handle Logger {
      info() {},
      return(v: number) { return v * 2; },
    } in { value() };
  `);
  assert.deepEqual({ ...exports.mapped }, { some: 21 });
  assert.equal(exports.method, 40);
});

test("the value of a body follows its final branches, and an empty body has none", () => {
  const { exports } = run(`${prelude}
    export const branch = handle Logger { info() {} } in {
      const a = 1;
      if (a > 0) { "yes" } else { "no" }
    };
    export const empty = handle Logger { info() {} } in {};
  `);
  assert.equal(exports.branch, "yes");
  assert.equal(exports.empty, undefined);
});

test("a function passes what it was given along, and an inner handler shadows an outer one", () => {
  const { exports } = run(`${prelude}
    const lines: string[] = [];
    function inner() / Logger: void { perform Logger.info("inner"); }
    function outer() / Logger: void {
      inner();
      handle Logger { info: m => { lines.push("shadow:" + m); } } in { inner(); };
      perform Logger.info("outer");
    }
    handle Logger { info: m => { lines.push(m); } } in { outer(); };
    export const logged = lines;
  `);
  assert.deepEqual([...exports.logged], ["inner", "shadow:inner", "outer"]);
});

test("a handler clause runs with the handlers around the handle", () => {
  const { exports } = run(`${prelude}
    const lines: string[] = [];
    function log() / Logger: void { perform Logger.info("x"); }
    handle Logger { info: m => { lines.push("outer:" + m); } } in {
      handle Logger { info: m => { perform Logger.info("wrapped " + m); } } in { log(); };
    };
    export const logged = lines;
  `);
  assert.deepEqual([...exports.logged], ["outer:wrapped x"]);
});

test("a generic effect gets its type from what makes it available", () => {
  const { exports } = run(`${prelude}
    function add(n: number) / State<number>: number {
      const value: number = perform State.get();
      perform State.set(value + n);
      return (perform State.get()) + 0;
    }
    function twice<S>(step: (s: S) => S) / State<S>: S {
      perform State.set(step(perform State.get()));
      perform State.set(step(perform State.get()));
      return perform State.get();
    }
    let s = 1;
    export const added = handle State<number> { get: () => s, set(v) { s = v; } } in { add(4) };
    export const doubled = handle State<number> { get: () => s, set(v) { s = v; } } in { twice<number>(v => v * 2) };
  `);
  assert.equal(exports.added, 5);
  assert.equal(exports.doubled, 20);
});

test("a generic effect's operations are typed by that instance", () => {
  assert.match(messages(`${prelude}
    function bad() / State<number>: string { return perform State.get(); }
  `).join("\n"), /'number' is not assignable to type 'string'/);
});

test("a generic operation keeps its type arguments", () => {
  const { exports } = run(`
    effect Http { fetch<T>(url: string, fallback: T): T; }
    function title() / Http: string { return perform Http.fetch<string>("/", "t"); }
    export const value = handle Http { fetch: (url, fallback) => fallback } in { title() };
  `);
  assert.equal(exports.value, "t");
});

test("an unannotated callback captures the capabilities around it", () => {
  const { exports } = run(`${prelude}
    const lines: string[] = [];
    function each(items: string[], visit: (item: string) => void) { for (let i = 0; i < items.length; i++) visit(items[i]); }
    function all(items: string[]) / Logger: void { each(items, item => perform Logger.info(item)); }
    handle Logger { info: m => { lines.push(m); } } in { all(["a", "b"]); };
    handle Logger { info: m => { lines.push("!" + m); } } in { each(["c"], item => perform Logger.info(item)); };
    export const logged = lines;
  `);
  assert.deepEqual([...exports.logged], ["a", "b", "!c"]);
});

test("first-class functions with clauses take the capabilities of their caller", () => {
  const { exports } = run(`${prelude}
    const lines: string[] = [];
    function apply(step: (x: string) / Logger => void, x: string) / Logger: void { step(x); }
    const step = function (x: string) / Logger { perform Logger.info(x); };
    const arrow = (x: string) / Logger => { perform Logger.info(x + "!"); };
    handle Logger { info: m => { lines.push(m); } } in { apply(step, "a"); apply(arrow, "b"); };
    export const logged = lines;
  `);
  assert.deepEqual([...exports.logged], ["a", "b!"]);
});

test("a function requiring fewer effects stands for one given more", () => {
  const { exports } = run(`${prelude}
    function apply(step: () / { Logger, Config } => string) / { Logger, Config }: string { return step(); }
    const step = function () / Config { return perform Config.get("k"); };
    export const value = handle Config { get: k => k + k } in handle Logger { info() {} } in { apply(step) };
  `);
  assert.equal(exports.value, "kk");
});

test("methods require effects, in classes, objects, and interfaces", () => {
  const { exports } = run(`${prelude}
    interface Named { name(id: string) / Config: string; }
    class Impl implements Named {
      prefix = "p";
      name(id: string) / Config: string { return this.prefix + (perform Config.get(id)); }
      static make(id: string) / Config: string { return perform Config.get(id); }
    }
    const object = { read(id: string) / Config: string { return perform Config.get(id); } };
    function viaInterface(named: Named) / Config: string { return named.name("n"); }
    export const values = handle Config { get: k => k.toUpperCase() } in {
      [new Impl().name("a"), Impl.make("b"), object.read("c"), viaInterface(new Impl())]
    };
  `, { noLib: false });
  assert.deepEqual([...exports.values], ["pA", "B", "C", "pN"]);
});

test("a function nested in one with other effects assembles what it needs", () => {
  const { exports, outputs } = run(`${prelude}
    const lines: string[] = [];
    function both() / { Logger, Config }: string { perform Logger.info("x"); return perform Config.get("k"); }
    function outer() / Logger: string {
      const inner = function () / Config { return both(); };
      return handle Config { get: k => k + "!" } in { inner() };
    }
    export const value = handle Logger { info: m => { lines.push(m); } } in { outer() };
    export const logged = lines;
  `);
  assert.equal(exports.value, "k!");
  assert.deepEqual([...exports.logged], ["x"]);
  assert.match(outputs.get("/main.js"), /both\(\{ Logger: \$effects(_\d+)?\.Logger, Config: \$effects(_\d+)?\.Config \}\)/);
});

test("rest and default parameters keep their places after the capability", () => {
  const { exports } = run(`${prelude}
    function sum(first = 1, ...others: number[]) / Config: string {
      let total = first;
      for (let i = 0; i < others.length; i++) total += others[i];
      return (perform Config.get("k")) + total;
    }
    export const value = handle Config { get: k => k } in { [sum(), sum(2, 3, 4)] };
  `);
  assert.deepEqual([...exports.value], ["k1", "k9"]);
});

test("effects cross files through named imports", () => {
  const { exports } = run({
    "/effects.tspp": `export effect Logger { info(message: string): void; }
      export function log(message: string) / Logger: void { perform Logger.info(message); }`,
    "/main.tspp": `import { Logger, log } from "./effects";
      const lines: string[] = [];
      function twice(message: string) / Logger: void { log(message); perform Logger.info(message); }
      handle Logger { info: m => { lines.push(m); } } in { twice("x"); };
      export const logged = lines;`,
  }, { noUnusedLocals: true });
  assert.deepEqual([...exports.logged], ["x", "x"]);
});

test("reports what is not available", () => {
  const unavailable = /The effect '(.*)' is not available here/;
  assert.match(messages(`${prelude} perform Logger.info("x");`).join("\n"), unavailable);
  assert.match(messages(`${prelude} function f() { perform Logger.info("x"); }`).join("\n"), unavailable);
  assert.match(messages(`${prelude}
    function g() / Logger: void {}
    function f() { g(); }
  `).join("\n"), unavailable);
  assert.match(messages(`${prelude}
    function g() / Logger: void {}
    g();
  `).join("\n"), unavailable);
  assert.match(messages(`${prelude}
    function outer() / Logger: void { function nested() { perform Logger.info("x"); } nested(); }
  `).join("\n"), unavailable);
  assert.match(messages(`${prelude}
    function g() / { Logger, Config }: void {}
    function f() / Logger: void { g(); }
  `).join("\n"), /The effect 'Config' is not available here/);
});

test("reports a different instance of an effect", () => {
  assert.match(messages(`${prelude}
    function g() / State<string>: void {}
    function f() / State<number>: void { g(); }
  `).join("\n"), /requires 'State<string>', but the 'State' in scope here is 'State<number>'/);
  assert.match(messages(`${prelude}
    function get<S>() / State<S>: S { return perform State.get(); }
    function f() / State<number>: void { get(); }
  `).join("\n"), /must be written out/);
});

test("reports declarations that cannot work", () => {
  assert.match(messages(`${prelude} interface Plain {} function f() / Plain: void {}`).join("\n"), /'Plain' is not an effect/);
  assert.match(messages(`${prelude} function f() / Missing: void {}`).join("\n"), /Cannot find name 'Missing'|Cannot resolve the effect/);
  assert.match(messages(`${prelude} function f() / { State<number>, State<string> }: void {}`).join("\n"), /already lists 'State'/);
  assert.match(messages(`${prelude} class C { get x() / Logger { return 1; } }`).join("\n"), /constructor or accessor|expected/);
  assert.match(messages(`effect E { x: number; }`).join("\n"), /may only declare operations/);
  assert.match(messages(`effect A { a(): void; } effect B { b() / A: void; }`).join("\n"), /An operation cannot require effects/);
  assert.match(messages(`${prelude}
    function f(a: number) / Logger: void;
    function f(a: string): void;
    function f(a: unknown) / Logger: void {}
  `).join("\n"), /same effects/);
});

test("reports a perform or handle of what is not an effect", () => {
  assert.match(messages(`namespace N { export interface P { x(): void; } } function f() { perform N.P.x(); }`).join("\n"), /not an effect|Cannot find/);
  assert.match(messages(`interface Plain { x(): void; } handle Plain { x() {} } in {};`).join("\n"), /'Plain' is not an effect/);
});

test("checks a handler against its effect", () => {
  assert.match(messages(`${prelude} handle Logger {} in {};`).join("\n"), /info/);
  assert.match(messages(`${prelude} handle Logger { info() {}, extra() {} } in {};`).join("\n"), /extra/);
  assert.match(messages(`${prelude} handle Logger { info: (m: number) => {} } in {};`).join("\n"), /not assignable|does not satisfy/);
  assert.match(messages(`${prelude} handle State<number> { get: () => "x", set() {} } in {};`).join("\n"), /string/);
  assert.match(messages(`${prelude} handle State { get: () => 1, set() {} } in {};`).join("\n"), /requires 1 type argument/);
});

test("a body cannot leave through return", () => {
  assert.match(messages(`${prelude} function f() { handle Logger { info() {} } in { return 1; }; }`).join("\n"), /cannot 'return'/);
  assert.deepEqual(messages(`${prelude} handle Logger { info() {} } in { const f = () => { return 1; }; f(); };`), []);
});

test("does not support continuation clauses yet, and says so", () => {
  assert.match(messages(`${prelude} handle Logger { control info(message, k) {} } in {};`).join("\n"), /not supported yet/);
});

test("relates functions by their clauses", () => {
  const relation = /effects|requires .(Config|State<number>).|no effect clause/;
  assert.match(messages(`${prelude}
    declare function g(x: number) / Logger: void;
    const plain: (x: number) => void = g;
  `).join("\n"), relation);
  assert.match(messages(`${prelude}
    declare function g(x: number): void;
    const effectful: (x: number) / Logger => void = g;
  `).join("\n"), relation);
  assert.match(messages(`${prelude}
    declare function g() / Config: void;
    const other: () / Logger => void = g;
  `).join("\n"), relation);
  assert.match(messages(`${prelude}
    declare function g() / State<number>: void;
    const other: () / State<string> => void = g;
  `).join("\n"), relation);
  assert.deepEqual(messages(`${prelude}
    declare function g() / Logger: void;
    const same: () / Logger => void = g;
    const more: () / { Logger, Config } => void = g;
  `), []);
});

test("rejects what would lose the capabilities", () => {
  assert.match(messages(`${prelude}
    declare function g() / Logger: void;
    function f() / Logger: void { g.call(undefined); }
  `).join("\n"), /its 'call' cannot be used/);
  assert.match(messages(`${prelude}
    declare function tag(s: TemplateStringsArray) / Logger: void;
    function f() / Logger: void { tag\`x\`; }
  `).join("\n"), /template tag/);
});

test("isolatedModules reports calls that need capabilities, and transpiling refuses effects", () => {
  assert.match(messages(`${prelude}
    function g() / Logger: void {}
    function f() / Logger: void { g(); }
  `, { isolatedModules: true }).join("\n"), /isolatedModules/);
});

test("writes declarations: the syntax in .d.tspp, a parameter in .d.ts", () => {
  const { program, outputs } = createProgram(`${prelude.replace(/effect /g, "export effect ")}
    export function greet(name: string) / { Logger, Config }: string { return perform Config.get(name); }
    export function typed<S>(step: (s: S) / State<S> => S) / State<S>: S { return step(perform State.get()); }
    export interface Greeter { hello() / Logger: void; }
    export class Impl { run(a: number) / Logger: number { return a; } }
  `, { declaration: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const rich = outputs.get("/main.d.tspp");
  const plain = outputs.get("/main.d.ts");
  assert.match(rich, /export effect Logger \{/);
  assert.match(rich, /function greet\(name: string\) \/ \{ Logger, Config \}: string;/);
  assert.match(rich, /hello\(\) \/ Logger: void/);
  assert.match(rich, /run\(a: number\) \/ Logger: number/);
  assert.match(plain, /export interface Logger \{/);
  assert.match(plain, /function greet\(__effects: \{\s*Logger: Logger;\s*Config: Config;\s*\}, name: string\): string;/);
  assert.match(plain, /hello\(__effects: \{\s*Logger: Logger;\s*\}\): void/);
  assert.match(plain, /run\(__effects: \{\s*Logger: Logger;\s*\}, a: number\): number/);
  assert.doesNotMatch(plain, /effect |perform|__tspp/);
});

test("reads a declaration it wrote", () => {
  const first = createProgram(`export effect Logger { info(message: string): void; }
    export function log(message: string) / Logger: void { perform Logger.info(message); }`, { declaration: true });
  first.program.emit();
  const declaration = first.outputs.get("/main.d.tspp");
  const { exports } = run({
    "/lib.d.tspp": declaration,
    "/main.tspp": `import { Logger, log } from "./lib";
      export const called = (globalThis as any) && handle Logger { info() {} } in { 1 };
      function use() / Logger: void { log("x"); }
      export { use };`,
  }, { noLib: false });
  assert.equal(exports.called, 1);
});

test("an inferred function type with a clause must be annotated for declarations", () => {
  assert.match(messages(`${prelude}
    export const f = function () / Logger { perform Logger.info("x"); };
  `, { declaration: true }).join("\n"), /declaration output cannot write/);
});

test("words of this syntax stay ordinary names", () => {
  const { exports } = run(`
    const effect = 1, perform = 2, handle = 3;
    const object = { effect, perform, handle };
    class C { effect() { return effect; } perform = perform; handle = handle; }
    export const a = effect + perform + handle + object.handle + new C().effect();
    export const b = (a) / handle;
    export const c = (a) / perform / effect;
  `);
  assert.equal(exports.a, 10);
  assert.equal(exports.b, 10 / 3);
  assert.equal(exports.c, 5);
});

test("a callback returned from a generic function keeps the instance's type", () => {
  const { exports } = run(`${prelude}
    function reader<S>() / State<S> { return () => perform State.get(); }
    function use() / State<number>: number { return reader<number>()() + 1; }
    export const value = handle State<number> { get: () => 1, set() {} } in { use() };
  `);
  assert.equal(exports.value, 2);
});

test("async functions and generators require effects like any other", async () => {
  const { exports } = run(`${prelude}
    async function load(key: string) / Config: Promise<string> {
      await null;
      return perform Config.get(key);
    }
    function* values(key: string) / Config: Generator<string> { yield perform Config.get(key); }
    export const promised = handle Config { get: k => k + "1" } in { load("a") };
    export const yielded = handle Config { get: k => k + "2" } in { [...values("b")] };
  `);
  assert.equal(await exports.promised, "a1");
  assert.deepEqual([...exports.yielded], ["b2"]);
  assert.match(messages(`${prelude}
    async function f() { handle Logger { info() {} } in { await null; }; }
  `).join("\n"), /cannot use 'await'/);
  assert.match(messages(`${prelude}
    async function f() { for (const x of []) { handle Logger { info() {} } in { for await (const y of []) {} }; } }
  `).join("\n"), /cannot use 'await'/);
  assert.match(messages(`${prelude}
    function* f() { handle Logger { info() {} } in { yield 1; }; }
  `).join("\n"), /cannot use 'yield'/);
  assert.match(messages(`${prelude}
    function f() { for (const x of []) { handle Logger { info() {} } in { break; }; } }
  `).join("\n"), /Jump target|break/);
  assert.deepEqual(messages(`${prelude}
    function f() { handle Logger { info() {} } in { for (const x of [1]) { break; } const g = async () => { await 1; }; g(); }; }
  `), []);
});

test("overloads pass capabilities whichever one is chosen", () => {
  const { exports } = run(`${prelude}
    function pick(a: number) / Config: string;
    function pick(a: string) / Config: string;
    function pick(a: unknown) / Config: string { return perform Config.get(String(a)); }
    export const value = handle Config { get: k => k + "!" } in { [pick(1), pick("x")] };
  `);
  assert.deepEqual([...exports.value], ["1!", "x!"]);
});

test("optional calls, super calls, and default exports pass capabilities", () => {
  const { exports } = run(`${prelude}
    class Base { name() / Config: string { return perform Config.get("base"); } }
    class Derived extends Base { name() / Config: string { return super.name() + "+"; } }
    const maybe: { run?: (() / Config => string) } = { run: function () / Config { return perform Config.get("opt"); } };
    export default function main() / Config: string { return new Derived().name() + (maybe.run?.() ?? ""); }
    export const value = handle Config { get: k => k } in { main() };
  `);
  assert.equal(exports.value, "base+opt");
});

test("effects are reached through namespace imports, and type-only imports are enough", () => {
  const { exports } = run({
    "/effects.tspp": `export effect Logger { info(message: string): string; }`,
    "/a.tspp": `import * as E from "./effects";
      export function viaNamespace() / E.Logger: string { return perform E.Logger.info("n"); }`,
    "/main.tspp": `import type { Logger } from "./effects";
      import { viaNamespace } from "./a";
      function viaType() / Logger: string { return perform Logger.info("t"); }
      export const value = handle Logger { info: m => m } in { viaNamespace() + viaType() };`,
  }, { verbatimModuleSyntax: false });
  assert.equal(exports.value, "nt");
});

test("declarations keep an import only a clause names", () => {
  const { program, outputs } = createProgram({
    "/effects.tspp": `export effect Logger { info(message: string): void; }`,
    "/main.tspp": `import { Logger } from "./effects";
      export function log() / Logger: void { perform Logger.info("x"); }`,
  }, withLib({ declaration: true, noUnusedLocals: true }));
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  assert.match(outputs.get("/main.d.ts"), /import \{ Logger \} from/);
  assert.match(outputs.get("/main.d.ts"), /log\(__effects: \{\s*Logger: Logger;\s*\}\): void;/);
  assert.match(outputs.get("/main.js"), /__esModule/);
  assert.doesNotMatch(outputs.get("/main.js"), /require\("\.\/effects"\)/);
});

test("transpiling a file on its own refuses effects", () => {
  const { ts } = require("../../test-support/compile.cjs");
  assert.throws(() => ts.transpileModule(`effect L { x(): void; } function f() / L: void { perform L.x(); }`, { fileName: "/main.tspp", compilerOptions: { module: ts.ModuleKind.CommonJS } }), /effects need the whole program/);
});

test("a clause of this plugin cannot share a signature with another's, and that does not crash", () => {
  assert.ok(messages(`${prelude} function f() / Logger / Config: void {}`).length > 0);
  assert.ok(messages(`${prelude} const f = () / Logger => 1;`).length > 0);
});

test("editor services read the lowered code", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const source = `${prelude}
    function greet(name: string) / { Logger, State<number> }: number {
      perform Logger.info(name);
      return perform State.get();
    }
    export const value = handle State<number> { get: () => 1, set(v) {} } in handle Logger { info: m => {} } in { greet("x") };
  `;
  const service = createLanguageService("/main.tspp", source);
  for (let position = 0; position < source.length; position += 3) service.getQuickInfoAtPosition("/main.tspp", position);
  assert.ok(service.getFormattingEditsForDocument("/main.tspp", {}));
  assert.deepEqual(service.getSemanticDiagnostics("/main.tspp").map(diagnostic => diagnostic.code), []);
  assert.deepEqual(service.getSyntacticDiagnostics("/main.tspp").map(diagnostic => diagnostic.code), []);
  const at = text => source.indexOf(text);
  const display = position => service.getQuickInfoAtPosition("/main.tspp", position)?.displayParts?.map(part => part.text).join("");
  assert.match(display(at("Logger.info(name)")), /interface Logger/);
  assert.match(display(at("info(name)")), /info\(message: string\): void/);
  assert.match(display(at("State.get()") + 6), /State<number>\.get\(\): number/);
  assert.match(display(at("Logger, State<number> }")), /interface Logger/);
  assert.match(display(at("m => {}")), /m: string/);
  assert.match(display(at("handle State")), /TS\+\+ keyword\) handle/);
  assert.match(display(at("perform Logger")), /TS\+\+ keyword\) perform/);
  assert.match(display(at("effect Logger")), /TS\+\+ keyword\) effect/);
  for (let position = 0; position < source.length; position += 2) service.getApplicableRefactors("/main.tspp", { pos: position, end: Math.min(position + 2, source.length) }, {});
  const definitions = service.getDefinitionAtPosition("/main.tspp", at("Logger.info(name)"));
  assert.ok(definitions?.some(definition => source.slice(definition.textSpan.start).startsWith("Logger {")));
  const references = service.findReferences("/main.tspp", at("Logger { info"))?.[0].references.map(reference => reference.textSpan.start);
  assert.ok(references?.includes(at("Logger.info(name)")));
  assert.ok(references?.includes(at("Logger, State<number> }")));
  const completions = service.getCompletionsAtPosition("/main.tspp", at("info(name)"), {});
  assert.ok(completions?.entries.some(entry => entry.name === "info"));
});
