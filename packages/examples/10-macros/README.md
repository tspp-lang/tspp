# 10 — Compile-time macros

This example exercises the whole macro capsule: AST inspection, generated declarations,
asynchronous expansion, recursive expansion, timeout budgets, and editor previews.
Every macro imports only types from `ts-plus-plus/plugins/macros/sdk`; runtime compiler services arrive
through `MacroContext`, so feature code does not import compiler internals.

Run `pnpm check`, or `pnpm build && pnpm start` to execute generated JavaScript.
