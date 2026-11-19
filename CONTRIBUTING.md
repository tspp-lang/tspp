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

## Commit formatting

Local installs enable Lefthook with Git 2.31 or newer. Older Git versions get a
format-only pre-commit hook. To install the hooks in an existing checkout, run
`node scripts/install-lefthook.mjs`.

Before a commit, staged UTF-8 text files have their line endings normalized and a
final newline added. Project files use LF; compiler TypeScript and JavaScript
sources retain CRLF to match the upstream formatter. Generated files, compiler
fixtures and baselines, binary files, and symbolic links are excluded.

The hook updates staged content without adding unstaged edits. The normalizer
updates a working file only when it matches the staged version; Lefthook may
temporarily hide and restore unstaged edits around the hook. This is line-ending
normalization, not a repository-wide style rewrite. Keep any broad style-formatting
changes in a separate commit.

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
