# Nominal types

This project enables only `@tspp/plugin-nominal-types`. It demonstrates distinct
nominal aliases, algebraic data constructors, and value matching. Plugin-owned
declarations remain `newtype` and `data` in `.d.tspp` output for downstream TS++
projects, while `.d.ts` contains their upstream TypeScript projection.

`src/index.tspp` is the exported package surface used by the consumer example.
`src/02-composed-patterns.tspp` preserves the original tutorial's `Either`,
nested outcome matching, guards, generic transforms, and nominal object case.

Run `pnpm check` for type checking or `pnpm build` to inspect
`dist/index.js`, `dist/index.d.tspp`, and `dist/index.d.ts`.
