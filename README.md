# TS++

TS++ (`ts-plus-plus`, abbreviated TSPP) is an experimental language and compiler
derived from TypeScript. This repository starts from the TypeScript 6.0.3 source
tree and develops TS++ as a separate product while preserving TypeScript as its
compatibility boundary.

The project grows through isolated feature capsules. Each feature owns its
syntax, semantic analysis, language-service additions, and editor metadata;
shared packages provide loading and narrow SDK contracts instead of accumulating
feature branches in the TypeScript-derived core.

## Repository layout

```text
.
└─ packages/
   ├─ compiler/          # TypeScript-derived TS++ compiler and tsserver
   ├─ examples/          # One independently configured project per plugin set
   ├─ language-server/   # LSP adapter around the TSPP server protocol
   ├─ playground/        # Browser compiler with worker-isolated capsule sets
   ├─ plugin-sdk/        # Public contracts shared by isolated plugin packages
   ├─ plugins/           # One package per complete feature capsule
   └─ vscode-extension/  # VSCode client for the TSPP language server
```

## Development

Use Node.js 22 and pnpm 12.4.2.

```sh
corepack enable
pnpm install
pnpm build
pnpm lint
pnpm test
pnpm playground:dev
```

## Commands

The compiler package exposes two commands:

- `tspp` — the TS++ command-line compiler;
- `tsppserver` — the TSPP compiler service using the upstream tsserver protocol.

The separate LSP package exposes `tspp-language-server`, which adapts that
protocol to LSP. The VSCode extension starts the LSP with the workspace
`ts-plus-plus` SDK and associates `.tspp` files with the `tspp` language mode.

Compiler extensions use `@tspp/plugin-sdk`. The SDK currently covers expression,
statement, declaration and type syntax; source projection; asynchronous program
analysis and artifacts; compile-time macros; semantic Quick Info; activation
dependencies and static editor contributions. New ports are added only when a
real feature demonstrates the boundary it needs.

Feature projects select capsules through `compilerOptions.plugins`. The host
validates required, optional and conflicting relationships, activates capsules
in dependency order, and keeps feature code out of the LSP and VS Code clients.

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
