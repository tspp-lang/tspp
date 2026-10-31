# @tspp/plugin-dependent-types

The dependent-types feature capsule for TSPP.

The package owns its source projection, MLTT parsing, kernel validation,
diagnostics, and editor grammar. Its semantic kernel is isolated under
`src/core`, but remains private to this feature until a second real consumer
requires a separately published package. Compiler and editor integration use
only `@tspp/plugin-sdk`.

The capsule supports cumulative universes, dependent functions, Bool/Nat
eliminators, ordered definitional type matching, identity types, path
induction, Sigma types, normalization, and references to earlier dependent
aliases. Its source projection lowers representable Pi signatures to ordinary
TypeScript generic call signatures while the independent analyzer retains the
stronger MLTT semantics. No MLTT implementation code lives in the compiler or
language-server packages.

Every successfully checked alias publishes a human-readable analysis artifact
containing both its normalized MLTT type and beta-normal term. In the development
host, run **TS++: Show MLTT Normal Forms** for the active file.

Implicit `{A: Type0}` binders become erased generic parameters, explicit
binders remain runtime parameters, and `auto` type arguments preserve inference
at the TypeScript call boundary. `reify T` produces a serializable descriptor
whose static type retains `T`; expression-level `match mltt` selects an exact
type branch at compile time and emits only that branch. Type-level `match mltt`
also supports ordered `infer` captures through the isolated MLTT matcher.

