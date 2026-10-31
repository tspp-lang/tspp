# Nominal types

This project enables only `@tspp/plugin-nominal-types`. It demonstrates distinct
nominal aliases, algebraic data constructors, and value matching. Plugin-owned
declarations remain `newtype` and `data` in `.d.ts` output for downstream TS++
projects.

Source lives in `src/`. Run `pnpm check` for type checking or `pnpm build` to
inspect `dist/index.js` and `dist/index.d.ts`.
