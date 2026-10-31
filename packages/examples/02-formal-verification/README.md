# 02 — Formal verification

This package exercises the verification path owned by
`@tspp/plugin-formal-verification`:

- closed and local `assert:` proof points plus trusted `assume:` facts;
- function `requires`/`ensures`, call-site checks, call summaries, branches,
  and multiple return paths;
- loop-invariant initialization and preservation;
- erased refinement types and predicate propagation;
- JavaScript-compatible bigint division/remainder and divisor obligations.
- explicit mathematical-real and overflow-checked safe-integer number models.
- strings, record fields, and branch-sensitive discriminated unions.

Run `pnpm check` in this directory. An invalid assertion, precondition call,
invariant, or refinement introduction produces a Z3 counterexample diagnostic
at the originating source expression.
