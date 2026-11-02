// Editor grammar contract: every keyword this plugin declares is highlighted in context, and bare angle brackets
// stay with TypeScript. Adapted from the legacy-monolith editor grammar tests (unittests/tspp/editorGrammars.ts).
const { test } = require("node:test");
const { getTSPPEditorKeywords } = require("@tspp/plugin-sdk/editor");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { typeComputationPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, typeComputationPlugin);
const samples = new Map([
  ["let", "type Y = let X = number in X;"],
  ["in", "type Y = let X = number in X;"],
  ["match", "type Name<T> = match T { 1: \"one\", _: \"many\" };"],
  ["infer", "type E<T> = match T { Array<infer U>: U, _: never };"],
  ["Type", "type Apply<F: Type => Type, A> = F<A>;"],
  ["Nat", "type N: Nat = Zero;"],
  ["Bool", "type B: Bool = True;"],
  ["True", "type B: Bool = True;"],
  ["False", "type B: Bool = False;"],
  ["Zero", "type N: Nat = Zero;"],
  ["Succ", "type N: Nat = Succ<Zero>;"],
  ["NatAdd", "type N: Nat = NatAdd<Zero, Zero>;"],
  ["BoolElim", "type X = BoolElim<A, B, C, D>;"],
  ["If", "type X = If<True, A, B, C>;"],
  ["NatElim", "type X = NatElim<A, B, C, D>;"],
  ["Eq", "type X = Eq<Nat, Zero, Zero>;"],
  ["Refl", "type X = Refl<Nat, Zero>;"],
  ["J", "type X = J<A, B, C, D, E, F>;"],
  ["Pair", "type X = Pair<A, B, C>;"],
  ["First", "type X = First<A>;"],
  ["Second", "type X = Second<A>;"],
  ["Ann", "type X = Ann<A, B>;"],
  ["Sigma", "type X = Sigma<(a: Nat) -> Nat>;"],
  ["auto", "select<auto, string>(1);"],
  ["reify", "const runtime = reify(Bool);"],
  ["typecase", "const t = typecase d { number => 1, _ => 2 };"],
]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of getTSPPEditorKeywords(typeComputationPlugin)) {
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
