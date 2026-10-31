# `@tspp/plugin-let-in-expression`

Adds the isolated expression form `let x = value in body` to TSPP.

The package depends only on `@tspp/plugin-sdk`. It receives parsing, checking,
and lowering capabilities from the compiler host and does not import compiler
internals or other plugins.
