# Proof Points and Function Contracts

```ts
assert: 1n + 1n === 2n;
function successor(value: bigint) with {
    requires: value >= 0n;
    ensures: result === value + 1n;
}: bigint {
    return value + 1n;
}
```

`assert:` requests a proof at the current location. `assume:` introduces a trusted premise without proving it. `requires` is an obligation for callers and a premise for the function body. `ensures` is checked on each return path, with `result` denoting the returned value. Verified call summaries are available to later proofs. Direct calls are also checked for preconditions; the verifier reports method calls that cannot be resolved unambiguously when a precondition may apply. Do not ignore those diagnostics. See [proof points](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/examples/12-formal-verification/src/01-proof-points.tspp) and [function contracts](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/examples/12-formal-verification/src/02-function-contracts.tspp).

When fixing a failed proof, determine whether the counterexample reveals a real defect, then inspect branches, parameter ranges, and call contracts. Change the specification only with user authorization. SMT results cover the parts modeled by the verifier and successfully proved.
