# TS++ Playground

The browser playground runs the compiler and selected feature capsules in a fresh Web Worker.
Changing the capsule selection restarts the worker, so process-global parser registrations never
leak between configurations. It displays both diagnostics and the TypeScript projection used by
upstream tooling.

Compile-time macros execute inside the compiler Web Worker through the compiler host boundary.
Formal verification uses a nested browser Z3 worker and loads its Wasm only after the first proof
obligation. The page therefore needs cross-origin isolation; the development and preview servers
send the required headers, while the production build includes a service-worker fallback for static
hosts such as GitHub Pages.

```sh
pnpm playground:dev
pnpm build:playground
```
