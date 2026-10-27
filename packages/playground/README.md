# tspp-playground

Browser playground for TS++: edit a TS++ project, toggle TS++ features, see diagnostics and
hovers, and share the result as a link. Live at <https://tspp-lang.github.io/tspp/>.

## How it works

```
index.html + src/main.ts        page: file tabs, examples, feature toggles, problems list, share link
  ├── src/monaco.ts             monaco editor core + the contributions we use (no bundled languages)
  ├── src/tsppLanguage.ts       "tspp" language: monaco's TypeScript Monarch grammar + TS++ keywords
  ├── src/providers.ts          hover / completion / signature help / definition / markers
  ├── src/client.ts             promise RPC to the language worker (types in src/protocol.ts)
  └── src/worker/languageWorker.ts
        │                       in-memory LanguageService over the project files
        └── src/worker/z3Bridge.ts → src/z3/z3Worker.cjs
                                Z3 (z3-solver, wasm) in a nested worker, started on first use
```

The compiler is not prebuilt or bundled separately. The worker imports `ts-plus-plus/source`
(the compiler's TypeScript sources) and Vite compiles them like any other module. The plugins in
`vite.config.ts` provide the rest:

- **Compiler sources go through esbuild**, with the compiler's own class-field semantics
  (`useDefineForClassFields: false`). Vite's default transformer (Oxc) cannot lower `export let`
  inside a namespace (`compiler/debug.ts`).
- **`virtual:tspp-libs`** serves the compiler's `src/lib/*.d.ts` under their built names
  (`lib.es2022.d.ts`, `lib.dom.d.ts`, … per `libs.json`).
- **`virtual:tspp-package-types`** provides declarations for `ts-plus-plus`,
  `ts-plus-plus/macros` and `ts-plus-plus/smt` under `/node_modules/ts-plus-plus`. The compiler
  sources use `isolatedDeclarations`, so each file's declaration is emitted on its own with
  `ts.transpileDeclaration` (no type check). The worker loads this chunk only once a file imports
  the package.
- **`virtual:tspp-examples`** reads every project in `packages/examples`: its `tsppconfig.json`
  features, `index.tspp` and everything under `src/`, plus `package.json` when a source refers
  to it.
- **Z3**: `src/z3/z3Worker.cjs` is bundled with z3-solver's browser build into `z3/z3.worker.js`,
  next to `z3/z3-built.wasm` (about 35 MB, fetched the first time a contract is checked).

The only generated input is `src/compiler/diagnosticInformationMap.generated.ts`; `pnpm dev` and
`pnpm build` run `hereby generate-diagnostics` first.

What the worker hosts for the compiler (the `CompilerHost` hooks a non-Node runtime provides):

- **Macros** run in the worker through `evaluateMacroModule`. The compiler serves
  `ts-plus-plus/macros` and `ts-plus-plus/smt` itself; `resolveMacroModule` adds the project's
  JSON files. No other modules are available to macro code.
- **Formal contracts** are solved by `solveVerificationQueries`, which forwards the compiler's
  SMT-LIB queries to Z3. Macro expansion and verification finish after the request that started
  them; the worker then sends `analysisSettled` and the page checks the open file again.

Z3 uses threads, so the page needs cross-origin isolation (`SharedArrayBuffer`). The Vite dev and
preview servers send the COOP/COEP headers; on GitHub Pages `public/coi-serviceworker.js`
(MIT, Guido Zuidhof) adds them from a service worker and reloads the page once.

The page checks the open file. The hover adds the same TS++ information as the VS Code
extension: `Normalized: … · Kind: …`, macro expansions, and verification results with
counterexamples.

The share link is the URL hash: `#features=a,b&file=<open file>&files=<lz-string JSON of all
files>`. The page keeps it up to date while you edit.

## Development

```sh
pnpm playground:dev     # from the repository root; http://localhost:5173/
pnpm build:playground   # production build into packages/playground/dist
```

Edits to the compiler sources reload the dev page directly; there is no bundle step to rerun.

## Deployment

`.github/workflows/playground.yml` builds this package on every push to `main`/`master` and
publishes `dist/` to GitHub Pages. The `playground` job in `ci.yml` runs the same build on pull
requests.
