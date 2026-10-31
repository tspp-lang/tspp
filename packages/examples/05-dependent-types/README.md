# Dependent types

This example enables only `@tspp/plugin-dependent-types`. The `src/index.tspp`
files exercise the complete plugin-owned MLTT kernel and its TypeScript
projection boundary:

- cumulative universes;
- explicit and implicit dependent function binders;
- type families and TypeScript generic-function interoperability;
- Bool and Nat eliminators;
- ordered definitional type matching with `infer` captures;
- identity types and path-induction primitives;
- Sigma types and dependent projections.
- runtime type descriptors and compile-time `match mltt` branch selection.

Run:

```sh
pnpm check
```

The MLTT kernel validates the authored terms before the capsule projects
representable Pi signatures to ordinary TypeScript call signatures. Features
that cannot be represented faithfully at that boundary remain inside the
plugin-owned kernel instead of weakening the host compiler.

