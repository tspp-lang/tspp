# TS++

TS++ (`ts-plus-plus`, abbreviated TSPP) is an experimental language and compiler
derived from TypeScript. This repository starts from the TypeScript 6.0.3 source
tree and develops TS++ as a separate product while preserving TypeScript as its
compatibility boundary.

The project is intentionally being rebuilt in small, isolated layers. The
current branch contains the upstream compiler in a pnpm monorepo and establishes
the TS++ package and command-line identity; language extensions will be added in
later commits.

## Repository layout

```text
.
└─ packages/
   └─ compiler/   # TS++ compiler, language services, build and test suite
```

## Development

Use Node.js 22 and pnpm 12.4.2.

```sh
corepack enable
pnpm install
pnpm build
pnpm lint
pnpm test
```

## Commands

The compiler package exposes two commands:

- `tspp` — the TS++ command-line compiler;
- `tsppserver` — the TS++ language server process.

During repository development, build the compiler before invoking its generated
outputs. The root scripts delegate to the `ts-plus-plus` workspace.

## TypeScript compatibility boundary

TS++ deliberately retains upstream internal names such as the `ts` namespace,
`typescript.js`, `tsconfig.json`, and the tsserver protocol. Those names describe
the TypeScript API and compatibility surface, not the public TS++ product name.
Keeping that boundary stable also makes future upstream comparison and merging
tractable.

## License and upstream notices

TS++ is distributed under the Apache License 2.0. The compiler package retains
the upstream TypeScript license, security policy, and third-party notices.
