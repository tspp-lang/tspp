# Dependent types

This example enables only `@tspp/plugin-dependent-types`. The `src/index.tspp`
file demonstrates the first migrated vertical slice:

- cumulative universes;
- explicit and implicit dependent function binders;
- type families;
- Bool, Nat, and identity types.

Run:

```sh
pnpm check
```

The MLTT kernel and diagnostics are active. Runtime call projection and full
TypeScript interoperability are the next semantic-type SDK milestone.

