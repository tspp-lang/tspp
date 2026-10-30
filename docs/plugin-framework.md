# TSPP plugin framework scaffold

The plugin framework starts with lifecycle and package boundaries, not guessed
compiler hooks.

```mermaid
flowchart LR
    PluginA[plugin package A] --> SDK[@tspp/plugin-sdk]
    PluginB[plugin package B] --> SDK
    SDK --> Registry[compiler static registry]
    Registry --> Compiler[TSPP compiler]

    PluginA -. no direct import .- PluginB
```

## Package boundary

- `@tspp/plugin-sdk` owns public plugin contracts and reusable host validation.
- `ts-plus-plus` owns the static composition root in
  `src/compiler/plugins/registry.ts`.
- each future plugin lives in its own package under `packages/plugins/`.
- plugin packages depend on the SDK and public compiler APIs, never compiler
  internals or another plugin implementation.

## What exists now

- stable plugin IDs and package versions;
- an explicit plugin API version;
- registration before activation;
- deterministic activation order and reverse cleanup;
- duplicate-ID and API-version checks;
- rollback when activation fails;
- one empty static compiler registry initialized by both the CLI and public
  compiler API entry points.

## What deliberately does not exist yet

- runtime package discovery;
- configuration-file loading;
- parser, binder, checker, emitter, or language-service hooks;
- plugin-to-plugin service lookup;
- ordering and dependency declarations.

The first real plugin should add the smallest compiler port it needs. Adding a
port without a real consumer would turn speculation into permanent API surface.
