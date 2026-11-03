// Pairs of plugins, in code that only compiles when both are active, with the errors that must survive the pairing.
// Passing without diagnostics proves little on its own: a plugin that swallows another's syntax also reports nothing,
// so each case either states what it must report or runs the result.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const vm = require("node:vm");
const { ts, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
const { allPlugins, useAllPlugins, pluginOrder } = require("./plugins.cjs");

useAllPlugins();

const options = { noLib: false, lib: ["lib.es2022.d.ts"], noImplicitAny: false };

function compile(source, extra = {}, fileName = "/main.tspp") {
  const { program, outputs } = createProgram({ [fileName]: source }, { ...options, ...extra });
  return { program, outputs, messages: diagnosticMessages(program) };
}

function run(source) {
  const { program, outputs, messages } = compile(source);
  assert.deepEqual(messages, []);
  const exports = {};
  vm.runInThisContext(`(function (exports, module) {\n${emitJavaScript(program, outputs)}\n})`)(exports, { exports });
  return exports;
}

async function verify(source) {
  const { program, messages } = compile(source);
  assert.deepEqual(messages, []);
  const analysis = (await ts.runTSPPProgramAnalyzers(program)).map(diagnostic => diagnostic.message);
  return { analysis, proofs: ts.getTSPPAnalysisArtifacts(program).map(artifact => `${artifact.name}: ${artifact.status}`) };
}

const macro = `macro function named([target], context) {
  return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
    context.factory.createVariableDeclaration(target.name + "Name", undefined, undefined, context.factory.createStringLiteral(target.name))]));
}`;

test("modern-syntax and nominal-types: blocks and bindings in match arms", () => {
  const { r } = run(`
    data S = A(x: number) | B;
    function f(s: S): number { return match s { A(x) => do { const y = x + 1; y * 2 }, B => let k = 3 in k + 1 }; }
    export const r = [f(A(1)), f(B)];`);
  assert.deepEqual(r, [4, 4]);
});

test("modern-syntax and nominal-types: a match in a use continuation", () => {
  const { r } = run(`
    data S = A(x: number) | B;
    function acquire(n: number, k: (v: S) => number): number { return k(A(n)); }
    export const r = do { use v <- acquire(5); match v { A(x) => x, B => 0 } };`);
  assert.equal(r, 5);
});

test("operator-sections and nominal-types: a match in a section", () => {
  const { r } = run(`
    data S = A(x: number) | B;
    const s: S = A(2);
    export const r = [1].map((_ + match s { A(x) => x, B => 0 }));`);
  assert.deepEqual(r, [3]);
});

test("operator-sections and dependent-types: sections in typecase arms", () => {
  const { r } = run(`
    const d = reify number;
    const f = typecase d { number => (_ + 1), _ => (_ + 2) };
    export const r = f(1);`);
  assert.equal(r, 2);
});

test("modern-syntax and dependent-types: typecase under let in a block", () => {
  const { r } = run(`export const r = do { const q = let d = reify number in typecase d { number => "n", _ => "o" }; q };`);
  assert.equal(r, "n");
});

test("nominal-types and dependent-types: data types in typecase, and match in its arms", () => {
  const { r, q } = run(`
    data Opt<T> = None | Some(value: T);
    const d = reify Opt<number>;
    const v = Some(1) as Opt<number>;
    export const r = typecase d { Opt<number> => match v { None => 0, Some(value) => value + 1 }, _ => -1 };
    export const q = typecase d { string => "string", _ => "other" };`);
  assert.equal(r, 2);
  assert.equal(q, "other");
});

test("type-computation and dependent-types: kind annotations keep their meaning beside dependent aliases", () => {
  const { messages } = compile(`
    type T1: Type = { a: number };
    export const bad1: T1 = 1;
    type T2: Type = string | number;
    export const bad2: T2 = true;
    type Lst: Type => Type = <A> =>> A[];
    export const bad3: Lst<number> = "x";
    export type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;
    export const good: Lst<number> = [1];`);
  assert.deepEqual(messages, [
    "Type 'number' is not assignable to type 'T1'.",
    "Type 'boolean' is not assignable to type 'T2'.",
    "Type 'string' is not assignable to type 'number[]'.",
  ]);
});

test("type-computation and nominal-types: kinded parameters in both declaration outputs", () => {
  const { messages, outputs, program } = compile(`
    interface Lst<T> { head: T }
    export data W<F: Type => Type> = W(value: F<string>);
    export newtype N<F: Type => Type> = F<number>;
    declare const w: W<Lst>;
    export const s: string = w.value.head;`, { declaration: true });
  assert.deepEqual(messages, []);
  program.emit();
  assert.match(outputs.get("/main.d.tspp"), /export data W<F: Type => Type> = W\(value: F<string>\);/);
  assert.match(outputs.get("/main.d.ts"), /export type W<F> = /);
  assert.deepEqual(ts.createSourceFile("/main.d.ts", outputs.get("/main.d.ts"), ts.ScriptTarget.ES2022).parseDiagnostics, []);
});

test("static-interface-members and type-computation: both shape one interface's declaration output", () => {
  const { messages, outputs, program } = compile(`
    export interface P<F: Type => Type> {
      static make(): number;
      inner: F<number>;
    }`, { declaration: true });
  assert.deepEqual(messages, []);
  program.emit();
  assert.match(outputs.get("/main.d.tspp"), /static make\(\): number;/);
  assert.doesNotMatch(outputs.get("/main.d.ts"), /make/);
  assert.match(outputs.get("/main.d.ts"), /inner: unknown;/);
});

test("macros and nominal-types: a macro over a data type", () => {
  const { n } = run(`${macro}
    data Sh = C | D;
    macro named(Sh);
    export const n = ShName;`);
  assert.equal(n, "Sh");
});

test("macros and dependent-types: both projections apply to one file", () => {
  const { n } = run(`${macro}
    export type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;
    interface I { a: number }
    macro named(I);
    export const n = IName;`);
  assert.equal(n, "I");
});

test("macros and static-interface-members: a macro over an interface with static members", () => {
  const { n } = run(`${macro}
    interface Pp { static p(): number; }
    macro named(Pp);
    export const n = PpName;`);
  assert.equal(n, "Pp");
});

test("macros and modern-syntax: a macro function written with modern syntax", () => {
  const { n } = run(`macro function named([target], context) {
      const name = let t = target.name in t + "Name";
      return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
        context.factory.createVariableDeclaration(name, undefined, undefined, context.factory.createStringLiteral(target.name))]));
    }
    interface Qq { a: number }
    macro named(Qq);
    export const n = QqName;`);
  assert.equal(n, "Qq");
});

test("formal-verification and modern-syntax: contracts hold over let and do", async () => {
  const proved = await verify(`
    export function f(v: bigint) with { requires: v >= 0n; ensures: result >= 0n; }: bigint {
      const y = let k = v in k;
      return do { y };
    }`);
  assert.deepEqual(proved, { analysis: [], proofs: ["f postcondition: proved"] });
  const refuted = await verify(`
    export function f(v: bigint) with { requires: v >= 0n; ensures: result >= 5n; }: bigint {
      return let k = v in k;
    }`);
  assert.deepEqual(refuted.proofs, ["f postcondition: failed"]);
});

test("formal-verification and modern-syntax: every path of a do block is checked", async () => {
  const source = bound => `
    export function f(v: bigint) with { requires: v >= 0n; ensures: result >= ${bound}; }: bigint {
      return do { if (v > 3n) { v } else { 7n } };
    }`;
  assert.deepEqual((await verify(source("3n"))).proofs, ["f postcondition: proved"]);
  assert.deepEqual((await verify(source("5n"))).proofs, ["f postcondition: failed"]);
});

test("formal-verification and nominal-types: contracts hold over match", async () => {
  const source = (bound, arm) => `
    data S = A(x: bigint) | B;
    export function f(s: S) with { requires: s.x >= 1n; ensures: result >= ${bound}; }: bigint {
      return match s { A(x) => ${arm}, B => 2n };
    }`;
  assert.deepEqual((await verify(source("1n", "x"))).proofs, ["f postcondition: proved"]);
  assert.deepEqual((await verify(source("5n", "x"))).proofs, ["f postcondition: failed"]);
  assert.deepEqual((await verify(source("5n", "6n"))).proofs, ["f postcondition: failed"]);
});

test("formal-verification and type-computation: contracts on generic and kinded functions", async () => {
  for (const parameters of ["<T>", "<F: Type => Type>"]) {
    const { proofs } = await verify(`export function f${parameters}(v: bigint) with { ensures: result >= 5n; }: bigint { return v; }`);
    assert.deepEqual(proofs, ["f postcondition: failed"]);
  }
});

test("formal-verification and type-computation: a contract on a generic function stays in the declaration output", () => {
  const { messages, outputs, program } = compile(`
    export function f<F: Type => Type>(v: bigint) with { ensures: result >= v; }: bigint { return v; }`, { declaration: true });
  assert.deepEqual(messages, []);
  program.emit();
  assert.match(outputs.get("/main.d.tspp"), /with \{ ensures: result >= v; \}/);
  assert.doesNotMatch(outputs.get("/main.d.ts"), /with/);
});

test("formal-verification rejects an inlined function that writes an outer value", async () => {
  const { analysis, proofs } = await verify(`
    export function f(v: bigint) with { ensures: result === v; }: bigint {
      const k = (() => { v = 1n; return 2n; })();
      return v;
    }`);
  assert.ok(analysis.some(message => message.includes("assigns an outer value")), analysis.join("\n"));
  assert.ok(!proofs.includes("f postcondition: proved") || analysis.length > 0);
});

test("formal-verification names no other plugin's syntax when it cannot model the lowered code", async () => {
  const sections = await verify(`export function f(v: bigint) with { ensures: result >= 5n; }: bigint { const g = (_ + 1n); return g(v); }`);
  assert.ok(sections.analysis.length > 0);
  assert.ok(sections.analysis.every(message => !message.includes("Unknown proof variable")), sections.analysis.join("\n"));
  const typecase = await verify(`const d = reify number;
    export function f(v: bigint) with { ensures: result >= 5n; }: bigint { const t = typecase d { number => 1, _ => 2 }; return v; }`);
  assert.ok(typecase.analysis.every(message => !message.includes("Unknown proof variable")), typecase.analysis.join("\n"));
});

test("formal-verification: an authored `as never` proves nothing, while the end of a match needs no proof", async () => {
  const authored = await verify(`export function f(v: bigint) with { ensures: result >= 5n; }: bigint { return v > 3n ? 10n : (0n as never); }`);
  assert.ok(!authored.proofs.includes("f postcondition: proved"), authored.proofs.join("\n"));
  assert.ok(authored.analysis.length > 0);
  const exhaustive = await verify(`
    data S = A | B;
    export function f(s: S) with { ensures: result >= 5n; }: bigint { return match s { A => 6n, B => 7n }; }`);
  assert.deepEqual(exhaustive.proofs, ["f postcondition: proved"]);
});

test("formal-verification leaves a value outside its model alone until a proof reads it", async () => {
  const ordinary = await verify(`export function g(target) { const name = target.name + "x"; return name; }`);
  assert.deepEqual(ordinary.analysis, []);
  const read = await verify(`export function g(target, v: bigint) with { ensures: result >= v; }: bigint { const n: any = target.name + "x"; return n; }`);
  assert.ok(read.analysis.some(message => message.includes("'n'")), read.analysis.join("\n"));
});

test("type-computation only takes a `<` closed by `>` after a type", () => {
  const { r, c } = run(`
    function acquire(n: number, k: (v: number) => number): number { return k(n); }
    export const r = do { use value: number <- acquire(40); value + 2 };
    const v: unknown = 2;
    export const c = v as number < 3;
    type Lst: Type => Type = <A> =>> A[];
    export const list: (Lst)<number> = [];`);
  assert.equal(r, 42);
  assert.equal(c, true);
});

test("operator-sections see through syntax other plugins lower to functions", () => {
  const { a, b, d, e } = run(`
    data S = A(x: number) | B;
    const items: S[] = [A(1), B];
    export const a = items.map((match _ { A(x) => x, B => 0 }));
    export const b = items.map((match _ { A(x) => x + 1, B => 0 }));
    export const d = [1, 2].map((let y = _ in y + 1));
    export const e = [1].map((do { _ + 1 }));`);
  assert.deepEqual([a, b, d, e], [[1, 0], [2, 0], [2, 3], [2]]);
  const messages = compile(`
    data S = A(x: number) | B;
    const items: S[] = [A(1)];
    export const missing = items.map((match _ { A(x) => x }));`).messages;
  assert.ok(messages.some(message => /Non-exhaustive match\. Missing patterns: B/.test(message)), messages.join("\n"));
  const written = compile(`export const f = [1].map(x => ((() => _ + x)()));`).messages;
  assert.ok(written.some(message => /Cannot find name '_'/.test(message)), written.join("\n"));
});

test("formal-verification refinements take an alias annotation of another plugin", async () => {
  const { analysis, proofs } = await verify(`
    type Pos: Type = bigint with { predicate: value > 0n; };
    export function f(v: Pos) with { ensures: result > 0n; }: bigint { return v; }
    export function g(): Pos { return -1n; }`);
  assert.ok(proofs.includes("f postcondition: proved"), proofs.join("\n"));
  assert.ok(analysis.some(message => /Pos return refinement could not be proved/.test(message)), analysis.join("\n"));
  const { program, outputs } = createProgram({ "/main.tspp": "export type Pos: Type = bigint with { predicate: value > 0n; };" }, { ...options, declaration: true });
  program.emit();
  const declaration = [...outputs].find(([name]) => name.endsWith(".d.tspp"));
  assert.match(declaration[1], /type Pos: Type0 = bigint with \{ predicate: value > 0n; \}/);
});

test("source projections leave strings and comments alone", () => {
  const source = `
    export const a = "macro m(T);";
    export const b = "type Fk: Nat = Zero;";
    export const c = "function g() with { ensures: result > 1n; }: bigint";
    export const d = \`data Fake = X | Y; assert: x; typecase \${"type Fk: Nat = Zero;"}\`;
    // type Fk: Nat = Zero;
    /* function g() with { ensures: true; } */`;
  const { a, b, c, d } = run(source);
  assert.equal(a, "macro m(T);");
  assert.equal(b, "type Fk: Nat = Zero;");
  assert.equal(c, "function g() with { ensures: result > 1n; }: bigint");
  assert.equal(d, "data Fake = X | Y; assert: x; typecase type Fk: Nat = Zero;");
  const { program, outputs } = compile(source);
  const javaScript = emitJavaScript(program, outputs);
  assert.match(javaScript, /\/\/ type Fk: Nat = Zero;/);
  assert.match(javaScript, /\/\* function g\(\) with \{ ensures: true; \} \*\//);
});

test("feature words stay ordinary identifiers", () => {
  const { sum, k } = run(`
    const data = 1, match = 2, reify = 3, typecase = 4, def = 5, use = 6, macro = 7, assume = 8, newtype = 9;
    export const sum = data + match + reify + typecase + def + use + macro + assume + newtype;
    export function assert(x: boolean) { return x; }
    assert(sum > 0);
    export const k = { assert: 1, data, match, with: 2 }.assert;`);
  assert.equal(sum, 45);
  assert.equal(k, 1);
});

test("plugin syntax does not exist outside TS++ files", () => {
  for (const source of [
    "export data Foo = A | B;",
    "export newtype Id = number;",
    "export const m = do { 1 };",
    "export const l = let a = 1 in a;",
    "const v = 1; export const s = match v { A => 1 };",
    "export const r = reify number;",
    "export type T = let X = string in X;",
    "export type U = match string { string: 1 };",
    "export type K<F: Type => Type> = F<number>;",
    "export type C = <A> =>> A;",
    "export type D: Nat = Zero;",
    "export function f(v: bigint) with { ensures: result > 0n; }: bigint { return v; }",
    "export interface I { static s(): void; }",
    "macro function m() {}",
  ]) {
    assert.notDeepEqual(compile(source, {}, "/main.ts").messages, [], source);
    assert.notDeepEqual(compile(source, {}, "/main.d.ts").messages, [], `${source} (declaration file)`);
  }
  // TypeScript's meaning stays, too: a parenthesized `_` is a value here.
  const { program, outputs } = compile("const _ = 3; export const b = (_ + 1);", {}, "/main.ts");
  assert.match(emitJavaScript(program, outputs), /exports\.b = \(_ \+ 1\);/);
  assert.equal(ts.getTSPPProjectedSource("/main.ts", "type D: Nat = Zero;"), "type D: Nat = Zero;");
});

test("Quick Info comes from the plugin whose syntax is under the cursor", () => {
  const source = `
    data S = A | B;
    const s: S = A;
    export const a = let v = 1 in v;
    export const b = match s { A => 1, B => 2 };
    export type C = let X = string in match X { string: 1, _: 2 };
    type Lst: Type => Type = <A> =>> A[];
    export type Two: Nat = Zero;
    let plain = 1;`;
  const service = createLanguageService("/main.tspp", source);
  const at = text => service.getQuickInfoAtPosition("/main.tspp", source.indexOf(text));
  const hover = text => ts.displayPartsToString(at(text).documentation ?? []);
  assert.match(hover("let v"), /inside an expression/);
  assert.match(hover("let X"), /intermediate type/);
  assert.match(hover("match s"), /data constructor/);
  assert.match(hover("match X"), /first matching type pattern/);
  assert.match(hover("Type =>"), /universe/);
  // `let` here is TypeScript's own keyword, so no plugin describes it.
  assert.equal(at("let plain"), undefined);
});

test("the result does not depend on the order plugins are loaded in", () => {
  // One process per order: the plugin registry lives as long as the process.
  const script = order => execFileSync(process.execPath, ["--max-old-space-size=1024", require.resolve("./order-probe.cjs"), order.join(",")], { encoding: "utf8" });
  const names = allPlugins().map(({ packageDirectory }) => packageDirectory);
  const sorted = [...names].sort();
  const baseline = script(sorted);
  assert.ok(JSON.parse(baseline).length > 0);
  assert.equal(script(pluginOrder(sorted, 3)), baseline);
  assert.equal(script([...sorted].reverse()), baseline);
});
