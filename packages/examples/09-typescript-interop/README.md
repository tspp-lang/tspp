# TypeScript interoperability

This package demonstrates the one-way source boundary and dual declaration surface:

- TS++ source may import ordinary TypeScript source.
- `dist/index.d.tspp` preserves plugin syntax for TS++ consumers.
- `dist/index.d.ts` projects the same API onto upstream TypeScript syntax.
- `tsppTypes` and the `tspp-types` export condition select the full surface only for TS++ consumers.

Run `pnpm check` to build the package and type-check `consumer/src/index.ts` with the upstream TypeScript compiler.
