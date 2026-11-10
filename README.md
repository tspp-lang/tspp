# TS++

English | [简体中文](README.zh-CN.md)

TS++ (`ts-plus-plus`, abbreviated TSPP) is an experimental language and compiler
derived from TypeScript. This repository starts from the TypeScript 6.0.3 source
tree and develops TS++ as a separate product while preserving TypeScript as its
compatibility boundary.

The project grows through isolated feature capsules. Each feature owns its
syntax, semantic analysis, language-service additions, and editor metadata;
shared packages provide loading and narrow SDK contracts instead of accumulating
feature branches in the TypeScript-derived core.

👉 **Looking for existing features?** Explore the [**TS++ Features & Plugin Catalog**](docs/features.md) for a comprehensive overview of all 8 active feature capsules, syntax specifications, and status.

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

Plugins written in `.tspp` build with the commit in [scripts/bootstrap-pin.json](scripts/bootstrap-pin.json). On a cache miss, `pnpm bootstrap:install` builds a compiler package from that commit in an isolated checkout. CI caches the package by commit, and local builds reuse it from the Git-ignored `.bootstrap/` directory. Keep the seed commit reachable when updating the pin.

For local experiments, build the workspace compiler with `pnpm build:compiler`, then set `TSPP_BOOTSTRAP=dev` when building the plugin. This mode uses the workspace's built compiler and plugin outputs. In PowerShell, set it with `$env:TSPP_BOOTSTRAP = 'dev'` and clear it with `Remove-Item Env:TSPP_BOOTSTRAP`.

## Commands

The compiler package exposes two commands:

- `tspp` — the TS++ command-line compiler;
- `tsppserver` — the TSPP compiler service using the upstream tsserver protocol.

The separate LSP package exposes `tspp-language-server`, which adapts that
protocol to LSP. The VSCode extension starts the LSP with the workspace
`ts-plus-plus` SDK and associates `.tspp` files with the `tspp` language mode.

## Releases

A release publishes three things, all at the version of the root `package.json`:
the `ts-plus-plus` package, the VS Code extension and the playground as a static
site in a zip. Every other package in the
workspace is internal, stays at `0.0.0` and is never published on its own:

- the feature plugins and the SDK travel inside `ts-plus-plus` as bundled dependencies.
  Projects name the plugins `ts-plus-plus/plugins/<name>`;
- the extension carries the language server.

The compiler package keeps the TypeScript version it implements as its own
version in the repository. The released manifest records that version as
`typescriptVersion`, which the language server reads to decide which TypeScript
features to offer.

```sh
pnpm pack:release   # builds, then assembles release/
pnpm test:release   # installs release/ into an empty project and exercises it
```

Releasing is setting the version: when the TSPP checks pass on a commit pushed
to master whose root version has no `vX.Y.Z` tag, `.github/workflows/release.yml`
runs both commands above on that commit and publishes the result on GitHub
Releases, which tags it. A
version with a prerelease part, such as `0.2.0-beta.1`, is published as a
prerelease. A version below one already released fails the TSPP checks
(`scripts/release-version.mjs`), so it never reaches a release. Nothing is published to npm or the Marketplace.

The steps, how to choose a version and what to do when a release fails are in
[docs/releasing.md](docs/releasing.md).

Compiler extensions use `@tspp/plugin-sdk`. The SDK currently covers expression,
statement, declaration and type syntax; source projection; asynchronous program
analysis and artifacts; compile-time macros; semantic Quick Info; activation
dependencies and static editor contributions. New ports are added only when a
real feature demonstrates the boundary it needs.

Feature projects select capsules through `compilerOptions.plugins`. The host
validates required and optional relationships, refuses plugins that claim the same
syntax, activates capsules in dependency order, and keeps feature code out of the LSP and VS Code clients.

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
