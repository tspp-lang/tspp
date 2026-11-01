# `@tspp/plugin-type-computation`

An isolated type-level computation capsule with these composable forms:

- `let Name = Value in Body` for lexical type bindings;
- `match Input { Pattern: Result, _: Fallback }` for ordered, non-distributive structural matching;
- `<T> =>> Body` for anonymous type constructors that can be applied through ordinary type-reference syntax;
- kind annotations such as `F: Type => Type`, first-class references to generic aliases and interfaces, and
  application of higher-kinded parameters through normal type-reference syntax. `Type` is the ordinary `Type0` kind,
  and the non-cumulative universe hierarchy treats `TypeN` itself as a value of kind `Type(N+1)`.

Higher-kinded types used to be a separate package; they share the type-constructor and kind machinery with type-level
`let` and constructors, so they now live here.

The package owns the surface syntax. It uses the compiler SDK's generic scoped binding, ordered matching, and type-constructor operations; the compiler core contains no feature id or keyword-specific branch.
