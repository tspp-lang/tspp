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

`number` is never silently treated as mathematical arithmetic. A function must
select `numberModel: "mathematical-real"` or `numberModel: "safe-integer"`.
The latter constrains parameters to JavaScript's exact integer range and emits
range obligations for executed addition, subtraction, and multiplication.

String equality and scalar fields of ordinary records/discriminated unions are
lowered into the same symbolic state. Branch conditions over `_tag` fields feed
the path solver, so field arithmetic and postconditions can use the narrowed
branch facts without a second TypeScript type checker inside the plugin.

All feature syntax is projected to equal-length whitespace before the upstream
TypeScript parser runs. Core only schedules the SDK's generic preprocessor and
background analyzer hooks; parsing, symbolic execution, SMT lowering, solver
isolation, diagnostics, and editor grammar remain in this package.

Every obligation also publishes a replayable SMT-LIB analysis artifact. In the
development host, run **TS++: Show Analysis Artifacts** to open all obligations
for the active file, ordered by source position and labelled with their proof
status. The editor consumes the SDK's generic artifact shape and does not know
about Z3 or formal-verification internals.
