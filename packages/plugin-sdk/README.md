# TSPP Plugin SDK

`@tspp/plugin-sdk` is the narrow public boundary between isolated plugin
packages and the TSPP compiler host.

The SDK provides plugin identity, API compatibility, deterministic activation,
logging, cleanup, and separate compiler, language-service, LSP, and editor
facets. Expression, function-body, statement, declaration and type syntax;
program analysis; source projection; macro execution; and semantic Quick Info
all have concrete feature consumers. The LSP facet remains a reserved lifecycle
boundary until a capability cannot be represented through tsserver.

Compiler AST values remain opaque to plugin packages. Plugins parse, check, and
lower through capabilities supplied by the host, avoiding a runtime dependency
back from a plugin into the compiler.

Plugin packages should use `definePlugin` for contextual typing, import
compiler contracts from `@tspp/plugin-sdk/compiler`, and never import compiler
internals or other plugin implementations.

Manifests may declare `requires`, `optionalDependencies`, `conflicts`, and
human-readable `capabilities`. The host validates the graph before activation,
orders dependencies first, and rejects incompatible feature sets explicitly.
