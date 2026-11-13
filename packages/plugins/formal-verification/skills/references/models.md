# Numbers, Refinement Types, and Logic

`bigint` division and remainder follow JavaScript's truncation-toward-zero semantics. Variable divisors introduce nonzero proof obligations. For `number`, select `numberModel: "mathematical-real";` or `numberModel: "safe-integer";` in the function or class's `with` clause. The former uses mathematical real arithmetic rather than IEEE floating-point semantics. The latter constrains parameters to safe integers and generates range obligations for executed addition, subtraction, and multiplication. The models exclude `NaN`; values from unverified code need boundary checks. See the [real-number model](../../../../examples/12-formal-verification/src/06-real-number-model.tspp) and [safe-integer model](../../../../examples/12-formal-verification/src/07-safe-integer-model.tspp).

```ts
type Positive = bigint with { predicate: value > 0n; };
const positive: Positive = 18n;
```

`value` denotes the constrained value. Prove the predicate when introducing or returning refined values; predicates on refined parameters are available to reasoning. Refinements are erased and cannot serve as runtime validation. See the [refinement examples](../../../../examples/12-formal-verification/src/04-refinement-types.tspp).

`ts-plus-plus/plugins/formal-verification/smt` provides reusable logic definitions, quantifiers, and recursive functions. Definitions are available across files in the same program. `axiom` introduces a trusted assumption; do not add one without authorization. See the [logic library examples](../../../../examples/12-formal-verification/src/10-logic-library.tspp). Tags and scalar fields of records, discriminated unions, and recursive data declarations can participate in proofs. Recursive payloads remain opaque; see the [recursive data examples](../../../../examples/12-formal-verification/src/09-recursive-data.tspp).
