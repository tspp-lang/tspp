# TS++ Compiler

This package contains the TS++ compiler, language services, build system, and
compiler test suite. It is published as `ts-plus-plus` and exposes the `tspp`
and `tsppserver` commands.

Run a TS++ source file with `tspp hello.tspp`. To compile a project or pass compiler options, use `tspp --compile -p tsppconfig.json`.

Direct execution requires Node.js 22.15 or newer with `module.registerHooks`. The runner uses the entry file's nearest `tsppconfig.json`, checks the program and waits for configured plugins before executing it. JavaScript is written to a temporary directory and removed after execution; arguments after the entry file are passed to the program. Literal imports and `require` calls are compiled ahead of time. Files loaded through computed import paths must be included in the project configuration.

Run compiler tasks from the repository root:

```sh
pnpm build:compiler
pnpm build:tests
pnpm lint
pnpm test
```

The implementation is derived from TypeScript and intentionally retains its
internal `ts` namespace, compiler API filenames, configuration format, and
language-server protocol as compatibility boundaries.

See the [repository README](../../README.md) for the project overview.
