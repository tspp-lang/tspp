# `@tspp/example-advanced-classes`

This example package demonstrates the 6 modern OOP features provided by `ts-plus-plus/plugins/advanced-classes`, their mutual interplay in realistic architectures, and their unique compile-time restrictions.

```tspp
// 1. field property with implicit backing storage and custom validation
class Counter {
  field count: number = 0 {
    get() { return field; }
    set(v) { if (v >= 0) field = v; }
  }
}

// 2. object singleton declaration & first-class type
object AppConfig {
  appName: string = "TS++";
}
function printConfig(cfg: AppConfig): string { return cfg.appName; }

// 3. data class with auto-synthesized copy(), equals(), toString()
data class Point(x: number, y: number)

// 4. with non-destructive functional copy expression
const origin = new Point(0, 0);
const moved = with(origin, { x: 10, y: 20 });

// 5. sealed class hierarchy (restricted to current file)
sealed abstract class Shape {
  abstract area(): number;
  final isPositiveArea(): boolean { return this.area() > 0; }
}
class Circle extends Shape { /* ... */ }

// 6. final class & final methods
final class SecureToken {
  constructor(public readonly secret: string) {}
}
```

---

## Feature Interplay (Combined Real-World Usage)

The new OOP features are designed to compose seamlessly:

* **`field` properties + `final` methods**: Encapsulate mutable state with validation alongside immutable public API invariants (e.g., `BankAccount`).
* **`sealed class` + `final` subclasses**: Model exhaustive, closed algebraic variants (e.g. `sealed abstract class TransactionStatus` with `final class PendingStatus` and `final class CompletedStatus`).

---

## Compile-Time Restriction Diagnostics

The compiler enforces strict OOP contracts at compile time. In `src/01-classes.tspp`, uncommenting any of the restriction blocks triggers specific diagnostics:

| Feature | Restriction Enforced | Diagnostic / Error Code |
| :--- | :--- | :--- |
| **`final class`** | Subclasses cannot inherit from final classes (`class Sub extends FinalBase`) | `[TS19101]` *Cannot inherit from final class* |
| **`final method`** | Subclasses cannot override final methods (`override finalMethod()`) | `[TS19103]` *Cannot override final member* |
| **`field`** | Backing identifier `field` cannot be referenced outside a getter or setter | `[TS19104]` *'field' is only allowed inside a getter or setter* |
| **`sealed class`** | Cannot be extended outside its declaring file | `[TS19102]` *Cannot extend sealed class outside of its declaring file* |
| **`with`** | Patch properties are strictly checked against target type | *Object literal may only specify known properties* |

---

## Scripts

```bash
# Type check and build JavaScript output
pnpm build

# Execute compiled demo
pnpm start

# Run ESLint
pnpm lint
```
