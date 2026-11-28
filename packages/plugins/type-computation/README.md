# `ts-plus-plus/plugins/type-computation`

An isolated type-level computation capsule with these composable forms:

- `let Name = Value in Body` for lexical type bindings;
- `match Input { Pattern: Result, _: Fallback }` for ordered, non-distributive structural matching. A bare `_` can
  also ignore a part of a structural pattern, as in `Container<_, infer Rest>`.
- `<T> =>> Body` for anonymous type constructors that can be applied through ordinary type-reference syntax;
- kind annotations such as `F: Type => Type`, first-class references to generic aliases and interfaces, and
  application of higher-kinded parameters through normal type-reference syntax. `Type` is the ordinary `Type0` kind,
  and the non-cumulative universe hierarchy treats `TypeN` itself as a value of kind `Type(N+1)`.

Terms of a Martin-Löf type theory can appear wherever a type can:

- `type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>` computes, and TypeScript sees the value: `type Two = 2`;
- `type Id: Type1 = <A>(value: A) => A` is a Pi type, written as a function type: later parameter types and the result
  can name earlier parameters. A type parameter `<A>` is erased, as in TypeScript, and `auto` type arguments leave a
  call to inference. A parameter of type `Type`, as in `(A: Type, value: A) => A`, is a type passed at run time:
  TypeScript sees `<A>(A: Reified<A>, value: A) => A`, and callers pass `reify T`;
- `(a: Nat, b: Nat) => Nat` is one signature, while `(a: Nat) => (b: Nat) => Nat` returns a function, as in TypeScript;
- `type Vec: Nat => Type = <N: Nat> =>> ...` is a type constructor indexed by a term, so `Vec<string>` is a kind error;
- `type Inc: Nat => Nat = <n: Nat> =>> Succ<n>` is a function over values, so `Inc<Two>` is `3`;
- `<P: Nat => Type0>(n: Nat) => P<n>` makes `P` a kinded type parameter and `P<n>` an ordinary application. A type
  constructor has no run-time value, so it cannot be a parameter in parentheses;
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

At run time, `reify T` produces a serializable descriptor `{ kind, text, shape }` of type `Reified<T>`, where `shape`
lists the primitive and literal types `T` is the union of. `T` must be known at compile time: a type parameter has no
descriptor to write down, so a function that needs one takes the type as a parameter `(A: Type)` instead. Only the
compiler makes a `Reified<T>`: an object with the same members is not one, and a `Reified<"a">` is no `Reified<string>`.

Expression-level `typecase` selects, at compile time, the first arm whose pattern accepts the described type, and
emits only that arm, after the scrutinee when it has side effects. When the descriptor is of a type parameter, such
as one passed in as `(A: Type)`, the type is known only at run time: `typecase` then tests the descriptor's `shape`
against each pattern in order, and checks each arm with `A` refined to `A & Pattern`. The descriptor shows that the
type is one of the pattern's, not that it is the pattern, so a value of type `A` reads as the pattern's type while
what is written to an `A` must still be an `A`. Such patterns are primitive types, literal types, and their unions;
`infer` needs a type known at compile time.

```ts
type Show = (A: Type, value: A) => string;
const show: Show = (A, value) => typecase A {
    number => value.toFixed(2),
    string => value.toUpperCase(),
    _ => "other"
};
show(reify number, 1.5); // "1.50"
```

With `nominal-types` enabled, ordinary user-defined indexed `data` constructors can package a runtime-selected index
with its payload. For example, `data SomeExpr { Some: <T extends Ty>(tag: T, expression: Expr<T>) => SomeExpr }` hides `T` in `SomeExpr`;
an ordinary value-level `match` introduces a fresh index for the arm and retains the relationship between `tag` and
`expression`. A type family written with type-level `match` can then map that index to its host value type. A
constructor `Pack: (A: Type, value: A) => AnyValue` keeps the hidden type itself as a descriptor, so `match item {
Pack(A, value) => typecase A { ... } }` recovers it; a constructor `Sized: (length: Nat, items: Vec<string, length>) =>
Sized` is indexed by a value, which is its own evidence. Repackage results that still depend on the hidden index
before returning them from the arm; a value index, or a value a `typecase` refined, may leave as its known type. No
built-in runtime pair constructor or unpacking keyword is required. The MLTT `Sigma`/`Pair` terms remain type-level
constructs; their tuple lowering does not supply this runtime existential checking.

Dependent types used to be a separate package, with `::` for their annotations and a text projection into TypeScript.
Kinds and universes are one concept with them, so they now live here too.

Higher-kinded types used to be a separate package; they share the type-constructor and kind machinery with type-level
`let` and constructors, so they now live here.

The package owns the surface syntax and lowers it to ordinary type nodes; the compiler core contains no feature id or
keyword-specific branch.

## How terms lower

The private MLTT core in `src/core` owns the Martin-Löf term IR, de Bruijn operations, normalization, definitional
equality, and bidirectional checking. The surrounding plugin owns the source syntax and translates into that kernel
through opaque external terms.

Terms of the theory lower as they are parsed. An alias annotation `type X: K = ...` is read as a kind when it can be
(`Type => Type`) and as a term otherwise (`Nat`). A function type is a term when it names something only the kernel
has, such as a universe, `Nat`, or a kind (`(n: Nat) => Vec<n>`), or when it is the body of an annotated alias; any
other function type is TypeScript's own, and its parameter names are no types. A built-in name such as `Nat`, in any
type position, also starts a term. Earlier versions wrote Pi types with `->` and implicit binders as `{A: K}`; both
are now syntax errors that say how to write them. `src/lower.ts` turns a term into ordinary type nodes: naturals into literals, Pi types into
generic signatures, and a `match` into a conditional type, so TypeScript decides it whether or not a binder is still
open. There is no fallback to `any`.

Kind equality is the kernel's definitional equality, which lets a kind be a term: `Vec: Nat => Type`. The kernel's errors
are reported by a diagnostic provider, like the checker's, and the analyzer publishes normal forms and warns where a term
has no TypeScript type. Names in a term resolve through the checker when it is checked, so a term sees aliases of other
files; when a term needs one to compute, its value is worked out then, if it is a natural or a boolean. The kernel never
calls two different TypeScript types apart, so it cannot contradict TypeScript's decision on a `match`.

`reify T` desugars to a descriptor object whose static type carries `T` in a phantom property, and expression-level
`typecase` desugars to a call whose overloads are its arms, so TypeScript's overload resolution selects the arm and
infers its captures. The type extension (`src/evidence.ts`) gives every descriptor type the trusted `Reified<T>`: the
structural type, from which TypeScript infers `T`, intersected with a type of the extension's own for `T`. It also
checks a `typecase` on a descriptor of a type parameter, arm by arm. A program rebuild without replacements adds the
emit transformer that writes each descriptor's `shape` and keeps only the selected arm, or a dispatch on the shape.
