# `@tspp/plugin-formal-verification`

An isolated formal-verification capsule. The package owns proof-point discovery,
SMT lowering, the resource-limited Z3 worker, and feature diagnostics. Core TSPP
only schedules the generic program analyzer declared by the plugin SDK.

The capsule supports closed Boolean/integer `assert:` proof points and symbolic
function `requires`/`ensures` clauses. Contract text is projected to equal-length
whitespace before the upstream TypeScript parser runs, so it is erased from
JavaScript without adding contract nodes to the compiler AST.

Integer loop invariants produce separate initialization and one-step
preservation obligations. The initial slice models parameter assumptions,
local initializers, the loop condition, and simple assignment updates.
