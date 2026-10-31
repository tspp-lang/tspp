# Newtype

This project enables only `@tspp/plugin-newtype`. It demonstrates distinct
nominal aliases over the same underlying type and the plugin-owned identity
constructor erasure. Its exported declaration remains `newtype` in `.d.ts`
output for downstream TS++ projects.

Source lives in `src/`. Run `pnpm check` for type checking or `pnpm build` to
inspect `dist/index.js` and `dist/index.d.ts`.
