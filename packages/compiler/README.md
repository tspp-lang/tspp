# TS++ Compiler

This package contains the TS++ compiler, language services, build system, and
compiler test suite. It is published as `ts-plus-plus` and exposes the `tspp`
and `tsppserver` commands.

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
