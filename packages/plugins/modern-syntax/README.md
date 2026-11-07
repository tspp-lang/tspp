# `ts-plus-plus/plugins/modern-syntax`

Owns the modern value-level syntax capsule for TSPP. The first slice supports
`let x = value in body`, completion-valued `do { ... }` expressions,
`function f() do { ... }` / method bodies whose final expression is returned,
`use pattern <- target` trailing-closure bindings, and `def` deep-readonly
bindings that emit as ordinary JavaScript `const` declarations.

The package depends only on `@tspp/plugin-sdk`. Completion blocks use the
generic function-body and trailing-closure SDK boundaries, so the compiler
host does not know which feature owns the `do`, `use`, or `def` prefixes.
