# Type computation

The original monolithic tutorial has been adapted to the capsule architecture
and organized as four independent chapters:

1. `01-let-bindings.tspp` — lexical type bindings, pipelines, and shadowing;
2. `02-type-match.tspp` — ordered literal and structural matching;
3. `03-type-lambdas.tspp` — anonymous constructors, currying, and composition;
4. `04-combined-computation.tspp` — all three forms used together.

The higher-kinded-types capsule is enabled explicitly for chapters 3 and 4,
where a type lambda is passed through a kind-checked type parameter. The
example deliberately uses structural TypeScript types so it does not silently
depend on the nominal-types capsule. Run `pnpm check` from this directory.
