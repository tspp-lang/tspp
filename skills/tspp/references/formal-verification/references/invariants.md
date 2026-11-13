# Loop and Class Invariants

```ts
function count(limit: bigint) with {
    requires: limit >= 0n;
    ensures: result === limit;
}: bigint {
    let current: bigint = 0n;
    while (current < limit) with {
        invariant: [current >= 0n, current <= limit];
    } { current += 1n; }
    return current;
}
```

Loop invariants generate separate initialization and one-step preservation obligations. On exit, combine the invariant with the negated loop condition to derive the result. Preserve the specification when changing invariants; do not remove obligations merely to suppress errors. See the [loop examples](https://github.com/tspp-lang/tspp/blob/v0.1.2/packages/examples/12-formal-verification/src/03-loop-invariants.tspp).

```ts
class Account with { invariant: balance >= 0n; } {
    private balance = 0n;
    deposit(amount: bigint) with { requires: amount >= 0n; }: void {
        this.balance += amount;
    }
}
```

Class invariants apply to private or readonly fields. Construction must establish them; instance methods must preserve them on returns, fallthrough, throws, and before calling out. Classes with invariants cannot let `this` escape, mutate invariant fields from closures or through other instances, or declare async or generator members. Invariants on derived classes, refinement types on fields, and overriding methods with contracts are currently unsupported. See the [class examples](https://github.com/tspp-lang/tspp/blob/v0.1.2/packages/examples/12-formal-verification/src/11-class-invariants.tspp).
