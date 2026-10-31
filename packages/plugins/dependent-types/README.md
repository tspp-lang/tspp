# @tspp/plugin-dependent-types

The dependent-types feature capsule for TSPP.

The package owns its source projection, MLTT parsing, kernel validation,
diagnostics, and editor grammar. Its semantic kernel is isolated under
`src/core`, but remains private to this feature until a second real consumer
requires a separately published package. Compiler and editor integration use
only `@tspp/plugin-sdk`.

The first vertical slice supports universe annotations, dependent function
types, the Bool/Nat/identity primitives, and references to earlier dependent
aliases. Runtime call projection and interoperability with arbitrary TypeScript
types require the semantic-type SDK layer and are intentionally not hidden
inside compiler-specific imports.

