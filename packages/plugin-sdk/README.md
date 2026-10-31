# TSPP Plugin SDK

`@tspp/plugin-sdk` is the narrow public boundary between isolated plugin
packages and the TSPP compiler host.

The SDK provides plugin identity, API compatibility, deterministic activation,
logging, cleanup, and separate compiler, language-service, LSP, and editor
facets. The expression-syntax compiler port is justified by the first real
plugin; the other facets currently define ownership and lifecycle boundaries
without speculative feature APIs.

Compiler AST values remain opaque to plugin packages. Plugins parse, check, and
lower through capabilities supplied by the host, avoiding a runtime dependency
back from a plugin into the compiler.

Plugin packages should use `definePlugin` for contextual typing, import
compiler contracts from `@tspp/plugin-sdk/compiler`, and never import compiler
internals or other plugin implementations.
