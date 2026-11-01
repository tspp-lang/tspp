// End-to-end behavior ported from the legacy-monolith compiler tests (unittests/tspp/typeComputation.ts).
// Not ported: feature-flag gating (plugins are enabled per project now), `=>` match separators (this plugin's
// syntax is `Pattern: Result`), `match mltt` and `TypeMatch<...>` (owned by the dependent-types kernel or removed),
// and applying a type lambda bound with `let` (the binding lowers to an `infer` variable that is not a constructor).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages, createLanguageService } = require("../../test-support/compile.cjs");
const { typeComputationPlugin } = require("../dist");
const { higherKindedTypesPlugin } = require("../../higher-kinded-types/dist");

usePlugins(typeComputationPlugin, higherKindedTypesPlugin);

const messagesOf = source => diagnosticMessages(createProgram(source).program);

function assertOnlyErrors(source, count, pattern = /not assignable/) {
  const messages = messagesOf(source);
  assert.equal(messages.length, count, messages.join("\n"));
  for (const message of messages) assert.match(message, pattern);
}

test("let binds a name the body can use", () => assertOnlyErrors(`
  type Twice<T> = let X = { value: T } in { first: X; second: X };
  const ok: Twice<number> = { first: { value: 1 }, second: { value: 2 } };
  const bad: Twice<number> = { first: { value: 1 }, second: { value: "x" } };
`, 1));

test("let does not leak its binding outside the body", () => assertOnlyErrors(`
  type Y = let X = number in X;
  const leak: X = 1;
`, 1, /Cannot find name 'X'/));

test("an inner let shadows an outer one", () => assertOnlyErrors(`
  type Y = let X = number in let X = string in X;
  const ok: Y = "s";
  const bad: Y = 1;
`, 1));

test("a shadowing let resolves its value in the outer scope", () => assertOnlyErrors(`
  type X = number;
  type Y = let X = X in X;
  const ok: Y = 1;
  const bad: Y = "x";
`, 1));

test("a let binding cannot refer to itself", () => assertOnlyErrors(`type Y = let X = X in X;`, 1, /Cannot find name 'X'/));

test("a let binding reports unbound type variables", () => assertOnlyErrors(`type Id<t> = let x = T in x;`, 1, /Cannot find name 'T'/));

test("let works inside a conditional type", () => assertOnlyErrors(`
  type Y<T> = T extends string ? let X = T in [X, X] : never;
  const ok: Y<"a"> = ["a", "a"];
  const bad: Y<"a"> = ["a", "b"];
`, 1));

test("match selects the first literal arm in order", () => assertOnlyErrors(`
  type Name<T> = match T { 1: "one", 2: "two", _: "many" };
  const a: Name<1> = "one";
  const b: Name<2> = "two";
  const c: Name<7> = "many";
  const bad: Name<1> = "two";
`, 1));

test("match keeps structural assignability", () => assertOnlyErrors(`
  type Classify<T> = match T { { value: 1 }: "matched", _: "fallback" };
  const exact: Classify<{ value: 1 }> = "matched";
  const wider: Classify<{ value: 1; extra: true }> = "matched";
  const bad: Classify<{ value: 1; extra: true }> = "fallback";
`, 1));

test("match captures type constructor arguments", () => assertOnlyErrors(`
  interface Array<T> {}
  type Id<t> = match t {
    Array<infer U>: 1,
    _: 0,
  };
  const ok: Id<Array<number>> = 1;
  const bad: Id<Array<number>> = 2;
`, 1));

test("match stays usable as an ordinary identifier", () => {
  assert.deepEqual(messagesOf(`
    let match = 5;
    match = 6;
    const out = match + 1;
  `), []);
  const calledOnNextLine = createProgram(`
    const match = (x: number) => x;
    match(1)
    { const ignored = 2; }
  `).program;
  assert.deepEqual(calledOnNextLine.getSyntacticDiagnostics().map(diagnostic => diagnostic.messageText), []);
});

test("type lambdas evaluate identity and tuple bodies", () => assertOnlyErrors(`
  type Id = <T> =>> T;
  type Pair = <A, B> =>> [A, B];
  const a: Id<number> = 1;
  const b: Pair<string, number> = ["hello", 42];
  const badA: Id<number> = "x";
  const badB: Pair<string, number> = [42, "hello"];
`, 3));

test("a type lambda can be a higher-kinded argument", () => assertOnlyErrors(`
  type Apply<F: Type => Type, X> = F<X>;
  type R = Apply<<T> =>> [T], number>;
  const ok: R = [123];
  const bad: R = 123;
`, 1));

test("type lambdas compose as higher-order combinators", () => assertOnlyErrors(`
  type Swap<F: (Type, Type) => Type> = <A, B> =>> F<B, A>;
  type SwappedTuple = Swap<<A, B> =>> [A, B]>;
  const ok: SwappedTuple<string, number> = [42, "hello"];
  const bad: SwappedTuple<string, number> = ["hello", 42];
`, 2));

test("named aliases instantiate through composed higher-kinded constructors", () => assert.deepEqual(messagesOf(`
  type Pair<A, B> = [A, B];
  type Flip<F: (Type0, Type0) => Type0> = <A, B>(a: A, b: B) => F<B, A>;
  type PairFlipped = Flip<Pair>;
  const pf: PairFlipped = (a, b) => [b, a];
  const flipped: [number, string] = pf("s", 1);
  type FlipT<F: (Type0, Type0) => Type0> = <A, B> =>> F<B, A>;
  type PairFlippedT = FlipT<Pair>;
  type Direct = PairFlippedT<string, number>;
  declare const direct: Direct;
  const directOk: [number, string] = direct;
`), []));

test("a type lambda alias accepts type constructors for its higher-kinded parameters", () => assert.deepEqual(messagesOf(`
  interface Array<T> {}
  type Box<T> = { value: T };
  type Apply = <F: Type => Type, T> =>> F<T>;
  type TestArray = Apply<Array, number>;
  type TestBox = Apply<Box, string>;
`), []));

test("kind-directed applications still check nested type arguments", () => {
  const messages = messagesOf(`
    interface Array<T> {}
    type Bar<T extends number> = T;
    type Id = <T> =>> T;
    type Foo<T> = T;
    type Apply = <F: Type => Type, T> =>> F<T>;
    type InLambda = Id<Bar<string>>;
    type InAlias = Foo<Bar<string>>;
    type InWrongArity = Foo<Bar<string>, 1>;
    type InHkt<F: Type => Type> = F<Bar<string>>;
    type InApply = Apply<Array, Bar<string>>;
  `);
  assert.equal(messages.filter(message => /does not satisfy the constraint/.test(message)).length, 5, messages.join("\n"));
  assert.equal(messages.length, 6, messages.join("\n"));
  assert.match(messages.join("\n"), /Generic type 'Foo' requires 1 type argument/);
});

test("type lambdas capture outer type parameters", () => assertOnlyErrors(`
  type Const<X> = <T> =>> X;
  type NumConst = Const<number>;
  const ok: NumConst<string> = 42;
  const bad: NumConst<string> = "hello";
`, 1));

test("type lambdas enforce their parameter constraints", () => assertOnlyErrors(`
  type OnlyString = <T extends string> =>> { str: T };
  type Ok = OnlyString<"hello">;
  type Bad = OnlyString<number>;
`, 1, /constraint/));

test("type lambdas curry", () => assertOnlyErrors(`
  type Curried = <A> =>> <B> =>> [A, B];
  type Step1 = Curried<number>;
  const ok: Step1<string> = [1, "two"];
  const bad: Step1<string> = ["two", 1];
`, 2));

test("type lambdas instantiate object literal bodies", () => assertOnlyErrors(`
  type Box = <T> =>> { readonly value: T };
  type BoxedNum = Box<number>;
  const ok: BoxedNum = { value: 123 };
  const bad: BoxedNum = { value: "x" };
`, 1));

test("feature-rich declarations keep let bindings and type lambdas", () => {
  const { program, outputs } = createProgram({
    "/main.tspp": `export type Y<T> = let X = { value: T } in [X, X];\nexport type Box = <T> =>> { box: T };`,
  }, { declaration: true, emitDeclarationOnly: true });
  program.emit();
  const declarations = [...outputs].filter(([fileName]) => fileName.endsWith(".d.tspp")).map(([, text]) => text).join("\n");
  assert.match(declarations, /let X = \{ value: T \} in \[X, X\]/, declarations);
  assert.match(declarations, /<T> =>> \{ box: T \}/, declarations);
});

test("hover shows explicit kinds for higher-kinded and type lambda parameters", () => {
  const source = `
    type Id<A> = A;
    type Compose<F: Type => Type, G: (Type, Type) => Type> = F;
    type Lam = <T> =>> T;
  `;
  const service = createLanguageService("/main.tspp", source);
  const hover = text => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", source.indexOf(text) + 1)?.displayParts);
  assert.equal(hover("<A>"), "(type parameter) A in type Id<A>");
  assert.equal(hover("<F"), "(type parameter) F in type Compose<F: Type => Type, G: (Type, Type) => Type>");
  assert.equal(hover("<T>"), "(type parameter) T in <T: Type0> =>>");
});
