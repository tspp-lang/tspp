# `@tspp/plugin-formal-verification`

An isolated formal-verification capsule. The package owns proof-point discovery,
SMT lowering, the resource-limited Z3 worker, and feature diagnostics. Core TSPP
only schedules the generic program analyzer declared by the plugin SDK.

The capsule supports closed and local `assert:` proof points, trusted `assume:`
facts, symbolic function `requires`/`ensures`, direct-call precondition checks,
verified call summaries, branch-sensitive return paths, and integer loop
invariants. Each invariant produces separate initialization and one-step
preservation obligations.

Refinement aliases such as `type Positive = bigint with { predicate: value >
0n; };` are erased from JavaScript. Their predicates are proved at introduction
and return sites and propagated from refined parameters. Runtime bigint `/` and
`%` use JavaScript's truncation-toward-zero semantics; variable divisors create
an explicit nonzero proof obligation.

All feature syntax is projected to equal-length whitespace before the upstream
TypeScript parser runs. Core only schedules the SDK's generic preprocessor and
background analyzer hooks; parsing, symbolic execution, SMT lowering, solver
isolation, diagnostics, and editor grammar remain in this package.
