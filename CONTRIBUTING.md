# Contributing to TS++

TS++ is an experimental compiler derived from TypeScript. Please open an issue
before starting a large language or architecture change so its boundaries and
compatibility impact can be discussed first.

## Development setup

Use Node.js 22 and pnpm 12.4.2:

```sh
corepack enable
pnpm install
pnpm build
```

The TypeScript-derived compiler lives in `packages/compiler`. Root commands
delegate to that workspace.

Before submitting a change, run the checks relevant to it:

```sh
pnpm lint
pnpm knip
pnpm build
pnpm test
```

Compiler behavior changes should include focused tests under
`packages/compiler/tests` or `packages/compiler/src/testRunner/unittests`.

## Design boundaries

- Keep new TS++ capabilities isolated behind explicit extension points.
- Preserve ordinary TypeScript behavior unless a documented TS++ feature is
  explicitly enabled.
- Treat the internal `ts` namespace, TypeScript compiler API, `tsconfig.json`,
  and tsserver protocol as compatibility surfaces rather than branding targets.
- Avoid broad mechanical rewrites of the upstream compiler when a narrow seam
  can express the same change.

TS++ is based on TypeScript, so upstream compiler tests, naming, and legal
notices remain where they describe the inherited implementation.
