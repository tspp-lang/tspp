# TS++ Playground

The browser playground runs the compiler and selected feature capsules in a fresh Web Worker.
Changing the capsule selection restarts the worker, so process-global parser registrations never
leak between configurations. It displays both diagnostics and the TypeScript projection used by
upstream tooling.

Formal verification and compile-time macros are intentionally excluded for now: their execution
adapters use Node worker threads. Both compiler features remain available in the CLI, language
server, and VS Code extension.

```sh
pnpm playground:dev
pnpm build:playground
```
