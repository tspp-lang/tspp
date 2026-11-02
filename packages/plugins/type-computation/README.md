# `@tspp/plugin-type-computation`

An isolated type-level computation capsule with these composable forms:

- `let Name = Value in Body` for lexical type bindings;
- `match Input { Pattern: Result, _: Fallback }` for ordered, non-distributive structural matching;
- `<T> =>> Body` for anonymous type constructors that can be applied through ordinary type-reference syntax;
- kind annotations such as `F: Type => Type`, first-class references to generic aliases and interfaces, and
  application of higher-kinded parameters through normal type-reference syntax. `Type` is the ordinary `Type0` kind,
  and the non-cumulative universe hierarchy treats `TypeN` itself as a value of kind `Type(N+1)`.

Terms of a Martin-Löf type theory can appear wherever a type can:

- `type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>` computes, and TypeScript sees the value: `type Two = 2`;
- `type Id: Type1 = {A: Type0} -> (value: A) -> A` is a Pi type, and TypeScript sees `<A>(value: A) => A`. Implicit
  `{A: Type0}` binders become erased generic parameters, and `auto` type arguments leave a call to inference;
- `type Vec: Nat => Type = <N: Nat> =>> ...` is a type constructor indexed by a term, so `Vec<string>` is a kind error;
- `type Inc: Nat => Nat = <n: Nat> =>> Succ<n>` is a function over values, so `Inc<Two>` is `3`;
- `(P: Nat => Type0) -> (n: Nat) -> P<n>` makes `P` a kinded type parameter and `P<n>` an ordinary application;
- `Eq`, `Refl`, `J`, `Sigma`, `Pair`, `First`, `Second`, `If`, `BoolElim`, and `NatElim` are built in, unless the file
  declares or imports a type of that name.

The kernel in `src/core` is independent of the compiler: it checks terms and works out what they compute. `src/lower.ts`
hands the result to TypeScript as ordinary type nodes, and the kernel's objections are ordinary type errors. A `match`
inside a term is always a conditional type, so TypeScript decides it the same way it decides a `match` outside one, and
the kernel only reduces one when the types are the same, so it never contradicts TypeScript. Names in a term resolve
through the checker when they are checked, so a term sees aliases of other files; one that needs an imported alias to
compute becomes its value then, if that is a natural or a boolean. Where a term has no TypeScript type, it is `unknown`,
with a warning that only the kernel checks it.
Each checked alias publishes its normal form; run **TS++: Show MLTT Normal Forms** for the active file.

At run time, `reify T` produces a serializable descriptor whose static type retains `T`, and expression-level
`typecase` selects, at compile time, the first arm whose pattern accepts the described type, and emits only that arm.

Dependent types used to be a separate package, with `::` for their annotations and a text projection into TypeScript.
Kinds and universes are one concept with them, so they now live here too.

Higher-kinded types used to be a separate package; they share the type-constructor and kind machinery with type-level
`let` and constructors, so they now live here.

The package owns the surface syntax. It uses the compiler SDK's generic scoped binding, ordered matching, and type-constructor operations; the compiler core contains no feature id or keyword-specific branch.
