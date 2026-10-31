# `@tspp/plugin-formal-verification`

An isolated formal-verification capsule. The package owns proof-point discovery,
SMT lowering, the resource-limited Z3 worker, and feature diagnostics. Core TSPP
only schedules the generic program analyzer declared by the plugin SDK.

The first vertical slice supports closed Boolean/integer `assert:` proof points.
Function contracts, symbolic values, and loop invariants build on the same
analysis port without adding feature-name branches to the compiler.
