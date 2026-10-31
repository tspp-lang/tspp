# `@tspp/plugin-type-computation`

An isolated type-level computation capsule with three composable forms:

- `let Name = Value in Body` for lexical type bindings;
- `match Input { Pattern: Result, _: Fallback }` for ordered, non-distributive structural matching;
- `<T> =>> Body` for anonymous type constructors that can be applied through ordinary type-reference syntax.

The package owns the surface syntax. It uses the compiler SDK's generic scoped binding, ordered matching, and type-constructor operations; the compiler core contains no feature id or keyword-specific branch.
