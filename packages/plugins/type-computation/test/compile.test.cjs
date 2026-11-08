// End-to-end behavior ported from the legacy-monolith compiler tests (unittests/tspp/typeComputation.ts).
// Not ported: feature-flag gating (plugins are enabled per project now), `=>` match separators (this plugin's
// syntax is `Pattern: Result`), and `typecase` and `TypeMatch<...>` (removed).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages, createLanguageService } = require("../../test-support/compile.cjs");
const { typeComputationPlugin } = require("../dist");

usePlugins(typeComputationPlugin);

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

test("later match arms still infer after an arm with let bindings", () => assertOnlyErrors(`
  type Transform<C, M: Type => Type> = match C {
    [infer L, infer R]: let A = M<L> in let B = M<R> in [A, B],
    { value: infer V }: { value: M<V> },
    infer Other: M<Other>,
  };
  type Wrap = <T> =>> { wrapped: T };
  const object: Transform<{ value: 1 }, Wrap> = { value: { wrapped: 1 } };
  const scalar: Transform<"s", Wrap> = { wrapped: "s" };
  const bad: Transform<"s", Wrap> = { wrapped: 1 };
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

test("a curried higher-kinded parameter applies one argument at a time", () => assertOnlyErrors(`
  type Apply2<F: Type => Type => Type> = F<number><string>;
  type R = Apply2<<A> =>> <B> =>> { a: A; b: B }>;
  const ok: R = { a: 1, b: "x" };
  const bad: R = { a: "x", b: 1 };
`, 2));

test("a let-bound type lambda can be applied in the body", () => assertOnlyErrors(`
  type One = let F = <T> =>> { value: T } in F<number>;
  type Curried = let P = <A> =>> <B> =>> { a: A; b: B } in P<number><string>;
  const one: One = { value: 1 };
  const curried: Curried = { a: 1, b: "x" };
  const badOne: One = { value: "x" };
  const badCurried: Curried = { a: "x", b: "y" };
`, 2));

test("a let-bound type lambda can be passed as a higher-kinded argument", () => assertOnlyErrors(`
  type Apply<F: Type => Type, X> = F<X>;
  type R = let F = <T> =>> { value: T } in Apply<F, string>;
  const ok: R = { value: "x" };
  const bad: R = { value: 1 };
`, 1));

test("a let-bound type lambda checks its arity and can be shadowed", () => {
  assertOnlyErrors(`type R = let F = <T> =>> { value: T } in F<number, string>;`, 1, /must be applied to 1 type argument/);
  assertOnlyErrors(`
    type R = let F = <T> =>> { value: T } in let F = number in F;
    const ok: R = 1;
    const bad: R = "x";
  `, 1);
});

test("an unused let binding is reported on its name", () => {
  const source = "type T = let Unused = number in string;";
  const { program } = createProgram(source, { noUnusedParameters: true });
  const [diagnostic, ...rest] = program.getSemanticDiagnostics();
  assert.deepEqual(rest, []);
  assert.equal(source.slice(diagnostic.start, diagnostic.start + diagnostic.length), "Unused");
});

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

test("feature-rich declarations write kind annotations with explicit universe levels", () => {
  const { program, outputs } = createProgram({
    "/main.tspp": [
      "export type Arrays: Type => Type = Array;",
      "export type Apply<F: Type => Type, X> = F<X>;",
      "export type Twice<G: (Type => Type) => Type, H: (Type, Type1) => Type> = G<Array>;",
      "export interface Functor<Container: Type => Type> { value: Container<number>; }",
      "export type Lifted = <F: Type => Type, T> =>> F<T>;",
      "export type Level: Type1 = Type;",
    ].join("\n"),
  }, { declaration: true, emitDeclarationOnly: true });
  program.emit();
  const declarations = [...outputs].filter(([fileName]) => fileName.endsWith(".d.tspp")).map(([, text]) => text).join("\n");
  for (const expected of [
    "export type Arrays: Type0 => Type0 = Array;",
    "export type Apply<F: Type0 => Type0, X> = F<X>;",
    "export type Twice<G: (Type0 => Type0) => Type0, H: (Type0, Type1) => Type0> = G<Array>;",
    "export interface Functor<Container: Type0 => Type0> {",
    "export type Lifted = <F: Type0 => Type0, T> =>> F<T>;",
    "export type Level: Type1 = Type;",
  ]) assert.ok(declarations.includes(expected), `${expected}\n---\n${declarations}`);
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

test("hover on a computed type alias shows its complete authored expression", () => {
  const source = `
    type Matched<Container, Mapper: Type => Type> = match Container {
      [infer Left, infer Right]: let Mapped = Mapper<Left> in [Mapped, Mapper<Right>],
      infer Value: Mapper<Value>
    };
    type Bound<Value> = let Result = Value[] in Result;
    type UnionArray<Value> = let Result = Value | string in Result[];
    type ObjectMatch<Value, Mapper: Type => Type> = match { value: Value } {
      { value: infer Element }: Mapper<Element>,
      infer Other: Other
    };
  `;
  const service = createLanguageService("/main.tspp", source);
  const hover = name => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", source.indexOf(name) + 1)?.displayParts);
  assert.equal(hover("Matched"), `type Matched<Container, Mapper: Type => Type> = match Container {
  [infer Left, infer Right]: let Mapped = Mapper<Left> in [Mapped, Mapper<Right>],
  infer Value: Mapper<Value>
}`);
  assert.equal(hover("Bound"), "type Bound<Value> = let Result = Value[] in Result");
  assert.equal(hover("UnionArray"), "type UnionArray<Value> = let Result = Value | string in Result[]");
  assert.equal(hover("ObjectMatch"), `type ObjectMatch<Value, Mapper: Type => Type> = match { value: Value } {
  { value: infer Element }: Mapper<Element>,
  infer Other: Other
}`);
});

test("declarations of inferred types the emitter writes as references still emit", () => {
  const { program, outputs } = createProgram({
    "/main.tspp": "class User { name = \"\"; }\nexport const user = new User();",
  }, { declaration: true, emitDeclarationOnly: true });
  program.emit();
  const compatibility = outputs.get("/main.d.ts") ?? "";
  assert.match(compatibility, /export declare const user: User;/, compatibility);
});

test("editor requests on the arrow of a kind annotation do not take it for a function", () => {
  const source = "type Apply<F: Type => Type, X> = F<X>;\ntype Arrays: Type => Type = Array;";
  const service = createLanguageService("/main.tspp", source);
  for (const position of [source.indexOf("=>"), source.lastIndexOf("=>")]) {
    assert.doesNotThrow(() => service.getQuickInfoAtPosition("/main.tspp", position));
    assert.deepEqual(service.getDocumentHighlights("/main.tspp", position, ["/main.tspp"]) ?? [], []);
    assert.deepEqual(service.getDefinitionAtPosition("/main.tspp", position) ?? [], []);
  }
});

test("kind errors carry this plugin's own codes", () => {
  const { program } = createProgram(`
    type Apply<F: Type => Type, X> = F<X>;
    type Bad = Apply<number, string>;
    type R = let F = <T> =>> { value: T } in F<number, string>;
  `);
  const codes = program.getSemanticDiagnostics().map(diagnostic => diagnostic.code).sort();
  assert.deepEqual(codes, [18072, 18073], diagnosticMessages(program).join("\n"));
});

test("hover on an ordinary parameter stays the language service's answer", () => {
  const source = "export function pick<T>(first: T, second: T): T { return first; }\n";
  const service = createLanguageService("/main.tspp", source);
  const hover = text => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", source.indexOf(text)).displayParts);
  assert.equal(hover("first"), "(parameter) first: T");
  assert.equal(hover("second"), "(parameter) second: T");
});
