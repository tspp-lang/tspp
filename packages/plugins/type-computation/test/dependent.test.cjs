// Terms of the type theory in ordinary aliases: the kernel checks them, and TypeScript reads what they lower to.
const assert = require("node:assert/strict");
const test = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { typeComputationPlugin, parseDependentType } = require("../dist");
const mltt = require("../dist/core/index.js");

usePlugins(typeComputationPlugin);

const options = { noLib: false, lib: ["lib.es2022.d.ts"] };
const check = source => diagnosticMessages(createProgram(source, options).program);

function emitted(source) {
  const { program, outputs } = createProgram(source, { ...options, declaration: true });
  program.emit();
  return { rich: outputs.get("/main.d.tspp"), compatible: outputs.get("/main.d.ts") };
}

test("parses and checks a genuinely dependent identity type", () => {
  const term = parseDependentType("{A: Type0} -> (value: A) -> A");
  assert.equal(term.kind, "pi");
  assert.deepEqual(mltt.inferMlttType(term), mltt.mlttUniverse(1));
});

test("keeps ordinary TypeScript generic types behind the external-term boundary", () => {
  const term = parseDependentType("(items: Array<string>) -> Array<string>");
  assert.deepEqual(mltt.inferMlttType(term), mltt.mlttUniverse(0));
  assert.equal(term.domain.kind, "external");
  assert.equal(term.domain.key, "Array");
  assert.equal(term.domain.arguments[0].displayName, "string");
});

test("Pi types are signatures TypeScript checks", () => {
  assert.deepEqual(check(`
    type Identity: Type1 = {A: Type0} -> (value: A) -> A;
    const id: Identity = <A>(value: A): A => value;
    export const s: string = id("text");
    export const n: number = id(1);`), []);
  assert.deepEqual(check(`
    type Identity: Type1 = {A: Type0} -> (value: A) -> A;
    const id: Identity = <A>(value: A): A => value;
    export const bad: string = id(1);`), ["Type 'number' is not assignable to type 'string'."]);
  assert.deepEqual(check(`
    type Select: Type1 = {A: Type0} -> (left: A) -> {B: Type0} -> (right: B) -> B;
    declare const select: Select;
    export const r: string = select<auto, string>(1, "right");`), []);
});

test("computed terms reach TypeScript as their values", () => {
  assert.deepEqual(check(`
    type One: Nat = Succ<Zero>;
    type Two: Nat = NatAdd<One, One>;
    type Four: Nat = NatAdd<Two, Two>;
    export const four: Four = 4;
    export const flag: If<True, Ann<Lam<(ignored: Bool) -> Type0>, (ignored: Bool) -> Type1>, string, number> = "text";`), []);
  assert.deepEqual(check(`
    type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;
    export const bad: Two = 3;`), ["Type '3' is not assignable to type '2'."]);
});

test("a match on types is decided by TypeScript, never falling back to any", () => {
  assert.deepEqual(check(`
    type R: Type0 = match number { number: string, _: boolean };
    export const bad: R = 123;`), ["Type 'number' is not assignable to type 'string'."]);
  assert.deepEqual(check(`
    type Element: Type1 = (A: Type0) -> match A { Array<infer E>: E, _: A };
    declare const first: Element;
    export const s: string = first<string[]>(["a"] as never);`).length, 0);
  // The same assignability inside a term and outside one.
  assert.deepEqual(check(`
    type Outside = match "a" { string: 1, _: 2 };
    type Inside: Type1 = (A: Type0) -> match "a" { string: 1, _: 2 };
    export const outside: Outside = 1;
    declare const inside: Inside;
    export const value: 1 = inside(null!);`), []);
});

test("reports the kernel's errors as type errors", () => {
  const messages = check(`
    export type WrongUniverse: Type0 = (A: Type0) -> A;
    export type BadSuccessor: Nat = Succ<True>;
    export type WrongAnnotation: Bool = Zero;`);
  assert.equal(messages.length, 3, messages.join("\n"));
  assert.match(messages[0], /Type1, not Type0/);
  assert.match(messages[1], /Expected Nat/);
  assert.match(messages[2], /Expected Bool, but inferred Nat/);
});

test("reports malformed binders as syntax errors", () => {
  const messages = check("export type MissingDomain: Type1 = (x: ) -> x;\nexport const fine = 1;");
  assert.ok(messages.some(message => /Expected a type before '\)'/.test(message)), messages.join("\n"));
});

test("an unknown name in a term is TypeScript's error, not a silent type", () => {
  assert.deepEqual(check("export type Bad: Type0 = (x: Mispelled) -> Mispelled;"), ["Cannot find name 'Mispelled'.", "Cannot find name 'Mispelled'."]);
});

test("a file's own types keep names that spell built-in terms", () => {
  assert.deepEqual(check(`
    type Pair<L, R> = [L, R];
    type Zero = string;
    export const p: Pair<number, Zero> = [1, "a"];
    export type Term: Nat = Succ<Succ<Term0>>;
    type Term0 = 0;`).filter(message => !/Expected Nat|Cannot find/.test(message)), []);
});

test("kinds can be terms: type constructors indexed by naturals", () => {
  assert.deepEqual(check(`
    type Two: Nat = Succ<Succ<Zero>>;
    type Vec: Nat => Type = <N: Nat> =>> { length: N };
    export const v: Vec<Two> = { length: 2 };
    export const w: Vec<Succ<Zero>> = { length: 1 };`), []);
  const messages = check(`
    type Vec: Nat => Type = <N: Nat> =>> { length: N };
    export type Bad = Vec<string>;`);
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /kind 'Nat' was expected/);
});

test("declaration output keeps terms as written and gives TypeScript their values", () => {
  const { rich, compatible } = emitted(`
    export type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;
    export type Identity: Type1 = {A: Type0} -> (value: A) -> A;`);
  assert.match(rich, /export type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;/);
  assert.match(rich, /export type Identity: Type1 = \{A: Type0\} -> \(value: A\) -> A;/);
  assert.match(compatible, /export type Two = 2;/);
  assert.match(compatible, /export type Identity = <A>\(value: A\) => A;/);
});

test("publishes normalized terms and their normalized MLTT types", async () => {
  const { program } = createProgram(`
    export type One: Nat = NatAdd<Zero, Succ<Zero>>;
    export type Proof: Type0 = Eq<Nat, One, Succ<Zero>>;`, options);
  assert.deepEqual(await ts.runTSPPProgramAnalyzers(program), []);
  const artifacts = ts.getTSPPAnalysisArtifacts(program);
  assert.equal(artifacts.length, 2);
  assert.equal(artifacts[0].kind, "dependent-types/normal-form");
  assert.match(artifacts[0].content, /One : Nat/);
  assert.match(artifacts[0].content, /One = Succ<Zero>/);
  assert.match(artifacts[1].content, /Eq<Nat, Succ<Zero>, Succ<Zero>>/);
});

test("parses and normalizes all built-in eliminators", () => {
  const trueResult = parseDependentType(
    "If<True, Ann<Lam<(ignored: Bool) -> Type0>, (ignored: Bool) -> Type1>, string, number>",
  );
  assert.equal(mltt.normalizeMlttTerm(trueResult).displayName, "string");

  const sum = parseDependentType("NatAdd<Succ<Zero>, Succ<Zero>>");
  assert.deepEqual(
    mltt.normalizeMlttTerm(sum),
    mltt.mlttSuccessor(mltt.mlttSuccessor(mltt.mlttZero())),
  );

  const pair = parseDependentType(
    "Pair<Sigma<(value: Nat) -> Eq<Nat, value, Zero>>, Zero, Refl<Nat, Zero>>",
  );
  assert.deepEqual(mltt.normalizeMlttTerm(mltt.mlttFirst(pair)), mltt.mlttZero());
  assert.equal(mltt.normalizeMlttTerm(mltt.mlttSecond(pair)).kind, "refl");
});

test("parses ordered type matching with generic captures", () => {
  const term = parseDependentType(
    "match Array<string> { Array<infer Element>: Element, _: never }",
  );
  assert.equal(term.kind, "type-match");
  assert.equal(term.cases.length, 1);
  assert.equal(term.cases[0].captures[0].name, "Element");
  assert.equal(term.cases[0].result.kind, "variable");
});

test("requires the '_' default arm to close a type match", () => {
  // Ported from the legacy-monolith compiler tests: arms match in source order, so `_` must come last.
  assert.throws(() => parseDependentType("match number { string: boolean }"), /must end with an '_' default arm/);
  assert.throws(() => parseDependentType("match number { _: never, string: number }"), /default arm must be the last arm/);
  assert.throws(() => parseDependentType("match number { { value: infer U }: U, _: never }"));
});

