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

Each browser project contains its real `tsconfig.json`. The Features panel is a shortcut editor for
`compilerOptions.plugins`; editing either side updates the other, and compiler options, include
patterns, and plugin selection are applied by the language worker. Configuration incompatibilities
are reported as project diagnostics. Run supports ES modules plus a browser-hosted CommonJS/Node
loader, and blocks unsupported module formats with an explanation instead of silently overriding
them. `noEmit` still applies to the real CLI build, while the explicitly requested Outputs and Run
views may emit in memory without writing files.

```sh
pnpm playground:dev
pnpm build:playground
```
