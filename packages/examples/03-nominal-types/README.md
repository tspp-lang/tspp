# Nominal types

This project enables only `@tspp/plugin-nominal-types`. It demonstrates distinct
nominal aliases, algebraic data constructors, and value matching. Plugin-owned
declarations remain `newtype` and `data` in `.d.tspp` output for downstream TS++
projects, while `.d.ts` contains their upstream TypeScript projection.

`src/01-basics.tspp` is the exported package surface used by the consumer example.
`src/02-composed-patterns.tspp` preserves the original tutorial's `Either`,
nested outcome matching, guards, generic transforms, and nominal object case.
`src/03-regressions.tspp` keeps focused regressions for constructor and hover
behavior. The separate `04-newtype-consumer` example verifies cross-package
nominal identity and `.d.tspp` consumption.

`data` declarations intentionally emit JavaScript constructor functions such
as `Some(value)`. Those functions create the tagged runtime values consumed by
value-level `match`; unlike an erased `newtype` constructor, they must remain
available to downstream JavaScript packages.

Run `pnpm check` for type checking or `pnpm build` to inspect
`dist/01-basics.js`, `dist/01-basics.d.tspp`, and `dist/01-basics.d.ts`.
