---
name: tspp-formal-verification
description: Write or troubleshoot TS++ formal proofs, function contracts, loop and class invariants, and refinement types.
---

# Formal Verification

Use `ts-plus-plus/plugins/formal-verification`. Check the project's `tsppconfig.json` and existing specifications first. When proofs fail, preserve behavior and contracts, and use diagnostics, counterexamples, and control flow to find missing facts or implementation errors. Without user authorization, do not add `assume:` or `smt.axiom`, strengthen `requires`, weaken `ensures`, or delete assertions or invariants just to pass verification. Report unsupported paths, solver failures, and timeouts; do not treat them as successful proofs.

- For function contracts, proof points, and calls, read [contracts](references/contracts.md).
- For loops and class state, read [invariants](references/invariants.md).
- For number models, refinement types, and the logic library, read [numbers and logic](references/models.md).

Proof syntax is erased from generated JavaScript and does not replace runtime boundary checks. Verify changes with a TS++ build. Use **TS++: Show SMT Source** in the editor to inspect proof obligations and their statuses. Consult the [plugin documentation](https://github.com/tspp-lang/tspp/blob/v0.1.2/packages/plugins/formal-verification/README.md) and [complete examples](https://github.com/tspp-lang/tspp/tree/v0.1.2/packages/examples/12-formal-verification).
