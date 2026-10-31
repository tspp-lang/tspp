# TSPP Plugin SDK

`@tspp/plugin-sdk` is the narrow public boundary between isolated plugin
packages and the TSPP compiler host.

The SDK provides plugin identity, API compatibility, deterministic activation,
logging, cleanup, and the expression-syntax capability port justified by the
first real plugin.

Compiler AST values remain opaque to plugin packages. Plugins parse, check, and
lower through capabilities supplied by the host, avoiding a runtime dependency
back from a plugin into the compiler.

Plugin packages should use `definePlugin` for contextual typing and must not
import compiler internals or other plugin implementations.
