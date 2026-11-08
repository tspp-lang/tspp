// The second phase: operations that suspend, `control` clauses that take the continuation, and the driver.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { algebraicEffectsPlugin } = require("../dist");

usePlugins(algebraicEffectsPlugin);

const prelude = `
effect Async {
  suspend sleep(ms: number): void;
  suspend ask<T>(question: string, fallback: T): T;
  note(message: string): void;
}
effect Logger { info(message: string): void; }
const lines: string[] = [];
`;
const handler = `handle Async {
  note(message) { lines.push(message); },
  control sleep(ms, k) { setTimeout(() => k.resume(), ms); },
  control ask(question, fallback, k) { k.resume(fallback); },
}`;

const options = extra => ({ noLib: false, ...extra });
const messages = (source, extra) => diagnosticMessages(createProgram(source, options(extra)).program);
const diagnostics = (source, extra) => {
  const { program } = createProgram(source, options(extra));
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
};

/** Compiles `files`, requires no errors, and returns the exports of `/main.js` and its text. */
function run(files, extra) {
  const sources = typeof files === "string" ? { "/main.tspp": files } : files;
  const { program, outputs } = createProgram(sources, options(extra));
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
      setTimeout,
      queueMicrotask,
      require: specifier => load(`/${specifier.replace(/^\.\//, "").replace(/\.tspp$/, "")}.js`),
    });
    return module.exports;
  };
  return { exports: load("/main.js"), js: outputs.get("/main.js"), outputs };
}

test("a handle with control clauses promises the value of a body that suspends", async () => {
  const { exports, js } = run(`${prelude}
    function work(name: string) / Async: string {
      perform Async.note("start " + name);
      perform Async.sleep(2);
      const answer = perform Async.ask<{ title: string }>("todo", { title: name.toUpperCase() });
      return answer.title;
    }
    function both() / Async: string { return work("a") + work("b"); }
    export const done: Promise<string> = ${handler} in { both() };
    export const logged = lines;
  `);
  assert.equal(await exports.done, "AB");
  assert.deepEqual([...exports.logged], ["start a", "start b"]);
  assert.match(js, /function\* work\(\$effects(_\d+)?, name\)/);
  assert.match(js, /\(yield \[\$effects(_\d+)?\.Async, "sleep", \[2\]\]\)/);
  assert.match(js, /\(yield\* work\(\$effects(_\d+)?, "a"\)\)/);
  assert.match(js, /\$effects(_\d+)?\.Async\.note\(/);
  assert.equal(js.match(/function __tspp_drive/g).length, 1);
});

test("the value of such a handle is typed as a promise", () => {
  assert.match(messages(`${prelude}
    function value() / Async: number { return 1; }
    export const wrong: number = ${handler} in { value() };
  `).join("\n"), /'Promise<number>' is not assignable to type 'number'/);
  assert.deepEqual(messages(`${prelude}
    function value() / Async: number { return 1; }
    export const mapped: Promise<string> = handle Async {
      note() {},
      control sleep(ms, k) { k.resume(); },
      control ask(q, f, k) { k.resume(f); },
      return: v => String(v),
    } in { value() };
  `), []);
});

test("resuming at once goes on in a loop, not deeper in the stack", async () => {
  const { exports } = run(`${prelude}
    function count(n: number) / Async: number {
      let total = 0;
      for (let i = 0; i < n; i++) total += perform Async.ask("i", 1);
      return total;
    }
    export const done = ${handler} in { count(100000) };
  `);
  assert.equal(await exports.done, 100000);
});

test("aborting throws where the operation was performed, so the body can retry or give up", async () => {
  const { exports } = run(`${prelude}
    effect Net { suspend get(url: string): string; }
    let attempts = 0;
    function fetchTwice(url: string) / Net: string {
      try { return perform Net.get(url); }
      catch (error) { return "retried " + perform Net.get(url); }
    }
    function fetchOnce(url: string) / Net: string { return perform Net.get(url); }
    export const retried = handle Net {
      control get(url, k) { attempts++ === 0 ? setTimeout(() => k.abort(new Error("down"))) : k.resume(url); },
    } in { fetchTwice("/a") };
    export const failed = handle Net {
      control get(url, k) { k.abort(new Error("gone " + url)); },
    } in { fetchOnce("/b") };
    export const thrown = handle Net {
      control get(url, k) { if (url) throw new Error("threw " + url); k.resume(url); },
    } in { fetchOnce("/c") };
  `);
  // Settled together, so that no rejection waits unhandled for an earlier assertion.
  const [retried, failed, thrown] = await Promise.allSettled([exports.retried, exports.failed, exports.thrown]);
  assert.equal(retried.value, "retried /a");
  assert.match(failed.reason.message, /gone \/b/);
  assert.match(thrown.reason.message, /threw \/c/);
});

test("finally blocks run when a computation is aborted", async () => {
  const { exports } = run(`${prelude}
    effect Stop { suspend stop(): void; }
    function guarded() / Stop: string {
      try { perform Stop.stop(); return "not reached"; }
      finally { lines.push("cleaned"); }
    }
    export const done = handle Stop { control stop(k) { k.abort(new Error("stopped")); } } in { guarded() };
    export const logged = lines;
  `);
  await assert.rejects(exports.done, /stopped/);
  assert.deepEqual([...exports.logged], ["cleaned"]);
});

test("a continuation runs once, and a second resumption rejects the handle", async () => {
  const { exports } = run(`${prelude}
    effect Once { suspend wait(): number; }
    function waited() / Once: number { return perform Once.wait() + perform Once.wait(); }
    let first = true;
    export const twice = handle Once {
      control wait(k) {
        if (first) { first = false; setTimeout(() => { k.resume(1); k.resume(2); }); }
        else setTimeout(() => k.resume(3), 5);
      },
    } in { waited() };
    export const late = handle Once { control wait(k) { k.resume(1); setTimeout(() => { try { k.resume(2); } catch (error) { lines.push(String(error)); } }); } } in { perform Once.wait() };
    export const logged = lines;
  `);
  await assert.rejects(exports.twice, /only once/);
  assert.equal(await exports.late, 1);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(exports.logged.join(), /only once/);
  assert.match(messages(`${prelude}
    effect Once { suspend wait(): number; }
    export const twice = handle Once { control wait(k) { k.resume(1); k.resume(2); } } in { perform Once.wait() };
  `).join("\n"), /already been resumed or aborted/);
});

test("a handler that never settles is a warning", () => {
  const found = diagnostics(`${prelude}
    effect Once { suspend wait(): number; }
    export const never = handle Once { control wait(k) { lines.push("lost"); } } in { perform Once.wait() };
  `);
  const warning = found.find(diagnostic => /never resumes or aborts 'k'/.test(diagnostic.messageText));
  assert.ok(warning);
  assert.equal(warning.category, 0);
});

test("a handle without control clauses inside a generator delegates to its body", async () => {
  const { exports, js } = run(`${prelude}
    function logged() / { Async, Logger }: string {
      perform Logger.info("before");
      perform Async.sleep(1);
      perform Logger.info("after");
      return "done";
    }
    function wrapped() / Async: string {
      return handle Logger { info: m => { lines.push("inner " + m); }, return: v => v + "!" } in { logged() };
    }
    export const done = ${handler} in { wrapped() };
    export const log = lines;
  `);
  assert.equal(await exports.done, "done!");
  assert.deepEqual([...exports.log], ["inner before", "inner after"]);
  assert.match(js, /\(yield\* \(function\* \(\$effects(_\d+)?\) \{/);
});

test("methods, function expressions, and arrow functions with a suspending clause are generators", async () => {
  const { exports, js } = run(`${prelude}
    class Worker {
      prefix = "w";
      run(n: number) / Async: string { perform Async.sleep(1); return this.prefix + n; }
      viaArrow(n: number) / Async: string {
        const step = (x: number) / Async => { perform Async.sleep(1); return this.prefix + x; };
        return step(n);
      }
    }
    const expression = function (n: number) / Async { return perform Async.ask("n", n * 2); };
    function apply(f: (n: number) / Async => number, n: number) / Async: number { return f(n); }
    export const done = ${handler} in { [new Worker().run(1), new Worker().viaArrow(2), apply(expression, 3)] };
  `);
  assert.deepEqual([...await exports.done], ["w1", "w2", 6]);
  assert.match(js, /\*run\(\$effects(_\d+)?, n\)/);
  assert.match(js, /\.bind\(this\)/);
});

test("a handle with control clauses inside a generator is its own computation", async () => {
  const { exports } = run(`${prelude}
    effect Inner { suspend wait(): number; }
    function inner() / Inner: number { return perform Inner.wait(); }
    function outer() / Async: Promise<number> {
      perform Async.sleep(1);
      return handle Inner { control wait(k) { setTimeout(() => k.resume(7)); } } in { inner() };
    }
    export const done = ${handler} in { outer() };
  `);
  assert.equal(await await exports.done, 7);
});

test("effects reach suspending code across files and through a written declaration", async () => {
  const lib = createProgram({ "/lib.tspp": `export effect Clock { suspend tick(): number; }
    export function ticks(n: number) / Clock: number { let t = 0; for (let i = 0; i < n; i++) t += perform Clock.tick(); return t; }` }, options({ declaration: true }));
  assert.deepEqual(diagnosticMessages(lib.program), []);
  lib.program.emit();
  const rich = lib.outputs.get("/lib.d.tspp");
  assert.match(rich, /export effect Clock \{ suspend tick\(\): number; \}/);
  assert.match(lib.outputs.get("/lib.d.ts"), /ticks\(__effects: \{\s*Clock: Clock;\s*\}, n: number\): Generator<unknown, number, unknown>;/);
  assert.match(lib.outputs.get("/lib.d.ts"), /__tspp_handler: \{\s*tick\(k: \{/);
  const program = createProgram({ "/lib.d.tspp": rich, "/main.tspp": `import { Clock, ticks } from "./lib";
    function twice() / Clock: number { return ticks(2) * 2; }
    export const done = handle Clock { control tick(k) { k.resume(5); } } in { twice() };` }, options());
  assert.deepEqual(diagnosticMessages(program.program), []);
  const { exports } = run({ "/lib.tspp": `export effect Clock { suspend tick(): number; }
    export function ticks(n: number) / Clock: number { let t = 0; for (let i = 0; i < n; i++) t += perform Clock.tick(); return t; }`, "/main.tspp": `import { Clock, ticks } from "./lib";
    function twice() / Clock: number { return ticks(2) * 2; }
    export const done = handle Clock { control tick(k) { k.resume(5); } } in { twice() };` });
  assert.equal(await exports.done, 20);
});

test("reports code that would suspend where it cannot", () => {
  const cannot = /suspends, so it must stand in a function whose clause lists a suspending effect/;
  assert.match(messages(`${prelude}
    function each(items: number[]) / Async: void { items.forEach(item => perform Async.sleep(item)); }
  `).join("\n"), cannot);
  assert.match(messages(`${prelude}
    function step() / Async: void { perform Async.sleep(1); }
    function each(items: number[]) / Async: void { items.forEach(() => step()); }
  `).join("\n"), cannot);
  assert.match(messages(`${prelude}
    handle Logger { info() {} } in { perform Async.sleep(1) };
  `).join("\n"), /not available|cannot/);
  assert.match(messages(`${prelude}
    function f(a = perform Async.ask("a", 1)) / Async: number { return a; }
  `).join("\n"), /a parameter's default value cannot/);
  assert.match(messages(`${prelude}
    export const done = handle Async {
      note: m => { perform Async.sleep(1); },
      control sleep(ms, k) { k.resume(); },
      control ask(q, f, k) { k.resume(f); },
    } in { 1 };
  `).join("\n"), /not available|cannot/);
});

test("reports clauses that do not fit their operations", () => {
  assert.match(messages(`${prelude}
    export const done = handle Async { note() {}, sleep: () => {}, control ask(q, f, k) { k.resume(f); } } in { 1 };
  `).join("\n"), /'sleep' suspends, so its handler is a 'control' clause/);
  assert.match(messages(`${prelude}
    export const done = handle Async { control note(m, k) { k.resume(); }, control sleep(ms, k) { k.resume(); }, control ask(q, f, k) { k.resume(f); } } in { 1 };
  `).join("\n"), /'note' does not suspend/);
  assert.match(messages(`${prelude}
    export const done = handle Logger { control info(m, k) { k.resume(); } } in { 1 };
  `).join("\n"), /'info' does not suspend/);
  assert.match(messages(`${prelude}
    export const done = handle Async { note() {}, control sleep: 1, control ask(q, f, k) { k.resume(f); } } in { 1 };
  `).join("\n"), /written as a method/);
  assert.match(messages(`${prelude}
    export const done = handle Async { note() {}, control sleep(ms, k) { k.resume(1); }, control ask(q, f, k) { k.resume(f); } } in { 1 };
  `).join("\n"), /not assignable|does not satisfy/);
});

test("reports functions that cannot be generators of requests", () => {
  assert.match(messages(`${prelude}
    async function f() / Async: Promise<void> { perform Async.sleep(1); }
  `).join("\n"), /An async function cannot require a suspending effect/);
  assert.match(messages(`${prelude}
    function* f() / Async: Generator<number> { yield 1; }
  `).join("\n"), /A generator cannot require a suspending effect/);
});

test("functions that suspend and functions that do not never stand for each other", () => {
  const relation = /may suspend|cannot suspend/;
  assert.match(messages(`${prelude}
    declare function quick() / Logger: void;
    const slow: () / { Logger, Async } => void = quick;
  `).join("\n"), relation);
  assert.match(messages(`${prelude}
    declare function slow() / Async: void;
    declare function apply(f: () / Logger => void): void;
    function g() / Logger: void { apply(slow as never); }
    const other: () / Logger => void = slow;
  `).join("\n"), /requires 'Async'|may suspend/);
  assert.deepEqual(messages(`${prelude}
    declare function slow() / Async: void;
    const more: () / { Async, Logger } => void = slow;
  `), []);
});

test("effects without suspending operations compile as before", () => {
  const { js } = run(`${prelude}
    function greet() / Logger: string { perform Logger.info("x"); return "y"; }
    export const value = handle Logger { info() {} } in { greet() };
  `);
  assert.doesNotMatch(js, /yield|__tspp_drive|function\*/);
});

test("transpiling to an older target turns the generators into state machines", async () => {
  const { exports } = run(`${prelude}
    function work() / Async: number { perform Async.sleep(1); return perform Async.ask("x", 4); }
    export const done = ${handler} in { work() };
  `, { target: 2, lib: ["lib.es2015.d.ts", "lib.dom.d.ts"] });
  assert.equal(await exports.done, 4);
});

test("signature help inside the parameters of a handler clause does not throw", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  // Every parameter list of a clause, including one being edited, starts after its `(` as upstream lists do.
  for (const clause of ["control sleep(s, k) { k.resume(); }", "control sleep(ms, k) { k.resume(); }", "note(m) { lines.push(m); }"]) {
    const source = `${prelude}
export const done = handle Async { ${clause} } in 1;
`;
    const service = createLanguageService("/main.tspp", source, { noLib: false });
    const open = source.indexOf(clause) + clause.indexOf("(") + 1;
    for (const position of [open, open + 1]) assert.doesNotThrow(() => service.getSignatureHelpItems("/main.tspp", position, undefined));
  }
});

test("signature help inside the parameters of an operation does not throw", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const service = createLanguageService("/main.tspp", prelude, { noLib: false });
  // An operation's list starts after its `(`, as upstream lists do.
  const open = prelude.indexOf("sleep(") + "sleep(".length;
  for (const position of [open, open + 1]) assert.doesNotThrow(() => service.getSignatureHelpItems("/main.tspp", position, undefined));
});

// Each arrangement puts the copy a handler's type makes of an operation somewhere else among the operations it overlaps.
const operationArrangements = [
  ["suspend ask<T>(question: string, fallback: T): T;", "note(message: string): void;"],
  ["note(message: string): void;", "suspend ask<T>(question: string, fallback: T): T;"],
  ["note(message: string): void;", "suspend ask<T>(question: string, fallback: T): T;", "suspend sleep(ms: number): void;"],
  ["suspend sleep(ms: number): void;", "suspend ask<T>(question: string, fallback: T): T;", "note(message: string): void;"],
];

const quickInfoText = (service, position) => {
  const { displayParts } = service.getQuickInfoAtPosition("/main.tspp", position);
  return displayParts.map(part => part.text).join("");
};

test("editor features inside an operation resolve to the operation, not to the copy in its handler's type", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  for (const operations of operationArrangements) {
    const body = operations.join(" ");
    const source = `effect Async { ${body} }\n`;
    const service = createLanguageService("/main.tspp", source, { noLib: false });
    const parameterType = source.indexOf("fallback: T") + "fallback: ".length;
    const typeParameter = source.indexOf("ask<T>") + "ask<".length;
    const returnType = source.indexOf("fallback: T): T") + "fallback: T): ".length;

    assert.match(quickInfoText(service, parameterType), /^\(type parameter\) T in Async\.ask<T>\(question: string, fallback: T\): T$/, body);
    assert.match(quickInfoText(service, source.indexOf("fallback")), /^\(parameter\) fallback: T$/, body);
    assert.match(quickInfoText(service, source.indexOf("message")), /^\(parameter\) message: string$/, body);
    assert.match(quickInfoText(service, source.indexOf("note")), /^\(method\) Async\.note\(message: string\): void$/, body);

    const definitions = service.getDefinitionAtPosition("/main.tspp", parameterType);
    assert.deepEqual(definitions.map(definition => definition.textSpan.start), [typeParameter], body);

    const references = service.findReferences("/main.tspp", parameterType).flatMap(symbol => symbol.references.map(reference => reference.textSpan.start));
    assert.deepEqual(references.sort((left, right) => left - right), [typeParameter, parameterType, returnType], body);
  }
});

test("an error in an operation is reported once, wherever the operation stands", () => {
  for (const operations of operationArrangements) {
    const source = `effect Async { ${operations.join(" ").replace("fallback: T", "fallback: Missing")} }\n`;
    const start = source.indexOf("Missing");
    const errors = createProgram(source).program.getSemanticDiagnostics().filter(diagnostic => diagnostic.messageText === "Cannot find name 'Missing'.");
    assert.deepEqual(errors.map(diagnostic => diagnostic.start), [start], source);
  }
});

test("an effect folds whether or not its operations suspend", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  for (const operation of ["suspend ask(): void;", "note(): void;"]) {
    const source = `effect Async {\n  ${operation}\n}\n`;
    const spans = createLanguageService("/main.tspp", source, { noLib: false }).getOutliningSpans("/main.tspp");
    // As upstream, a fold starts at the full start of the `{`, so at the space before it.
    const start = source.indexOf(" {");
    assert.deepEqual(spans.map(span => span.textSpan), [{ start, length: source.indexOf("}") + 1 - start }], operation);
  }
});
