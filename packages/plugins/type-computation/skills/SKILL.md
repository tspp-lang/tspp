---
name: tspp-type-computation
description: Write or troubleshoot TS++ type-level let and match, type constructors, higher-kinded types, and dependent types.
---

# Type Computation

Enable `ts-plus-plus/plugins/type-computation`. This plugin includes both higher-kinded and dependent types. Check types and kinds with the existing TS++ build. Distinguish type-level `match` from the value-level `match` owned by nominal-types.

```ts
type Identity = <T> =>> T;
type Apply<F: Type => Type, A> = F<A>;
type Box = <T> =>> { value: T };
type Boxed = Apply<Box, number>;
type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;
```

Type-level `let Name = Value in Body` introduces a lexical binding. `match T { Pattern: Result, _: Fallback }` performs ordered, non-distributive structural matching; patterns support `infer` and `_`. `<T> =>> Body` constructs an applicable type function. `Type` is `Type0`, and universes are non-cumulative. Dependent types support built-in Pi types, naturals, booleans, equality, Sigma types, and related terms; a Pi type is a function type such as `(n: Nat) => Vec<n>` or `<A>(value: A) => A` (the earlier `->` and `{A: K}` are gone), and a parameter `(A: Type)` passes the type at run time as its `reify` descriptor; declarations or imports with the same names shadow the built-ins. Terms without a TypeScript representation lower to `unknown` with a warning that only the kernel checks them.

`reify T` produces a descriptor of type `Reified<T>`, which only the compiler can make. Expression-level `typecase` selects a branch at compile time and emits only that branch; on a descriptor of a type parameter, such as `(A: Type)`, it branches at run time on primitive and literal patterns and refines `A` to `A & Pattern` in each arm. Use **TS++: Show MLTT Normal Forms** in the editor to inspect checked terms. Consult the [plugin documentation](../README.md), [type computation examples](../../../examples/08-type-computation/), and [dependent type examples](../../../examples/10-dependent-types/).
