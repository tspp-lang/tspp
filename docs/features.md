# TS++ Features & Plugin Catalog

TS++ extends TypeScript with modern language features through **isolated feature capsules** powered by [`@tspp/plugin-sdk`](file:///e:/Repos/ts-plus-plus/packages/plugin-sdk). Rather than accumulating intrusive modifications in the upstream TypeScript-derived core, every feature is encapsulated as an independent plugin owning its syntax, type checking, AST lowering, editor diagnostics, and language-service contributions.

Features are opt-in and composable via `tsconfig.json` (`compilerOptions.plugins`).

---

## Overview Matrix

| Feature Capsule | Package Name | Status | Key Capabilities | Example Project |
| :--- | :--- | :--- | :--- | :--- |
| [**Advanced Classes**](#1-advanced-classes) | `@tspp/plugin-advanced-classes` | Stable | `field` backing storage, `object` singletons, `data class`, `with` copy expressions, `sealed class`, `final class` & methods | [`12-advanced-classes`](file:///e:/Repos/ts-plus-plus/packages/examples/12-advanced-classes) |
| [**Modern Syntax**](#2-modern-syntax) | `@tspp/plugin-modern-syntax` | Stable | `let ... in ...` expressions, `do { ... }` blocks, completion-valued bodies, `def` deep-readonly declarations, `use <-` trailing closures | [`01-modern-syntax`](file:///e:/Repos/ts-plus-plus/packages/examples/01-modern-syntax) |
| [**Formal Verification**](#3-formal-verification) | `@tspp/plugin-formal-verification` | Stable | SMT/Z3 automated theorem proving, `requires`/`ensures` contracts, `assert:`/`assume:` proof points, `invariant:` loop invariants, refinement types | [`02-formal-verification`](file:///e:/Repos/ts-plus-plus/packages/examples/02-formal-verification) |
| [**Nominal Types & ADTs**](#4-nominal-types--algebraic-data-types) | `@tspp/plugin-nominal-types` | Stable | Zero-cost `newtype` nominal abstractions, tagged union `data` declarations, exhaustive pattern `match` expressions with guards | [`03-nominal-types`](file:///e:/Repos/ts-plus-plus/packages/examples/03-nominal-types), [`04-newtype-consumer`](file:///e:/Repos/ts-plus-plus/packages/examples/04-newtype-consumer) |
| [**Type Computation & HKT**](#5-type-computation-higher-kinded--dependent-types) | `@tspp/plugin-type-computation` | Stable | Higher-Kinded Types (`Type => Type`), Dependent Types (Martin-Löf Type Theory), type-level `let`, `<T> =>> Body` constructors, `reify`, `typecase` | [`05-dependent-types`](file:///e:/Repos/ts-plus-plus/packages/examples/05-dependent-types), [`06-type-computation`](file:///e:/Repos/ts-plus-plus/packages/examples/06-type-computation), [`07-higher-kinded-types`](file:///e:/Repos/ts-plus-plus/packages/examples/07-higher-kinded-types) |
| [**Static Interface Members**](#6-static-interface-members) | `@tspp/plugin-static-interface-members` | Stable | Static-side contracts in interfaces (`static deserialize(): this`), typeclasses, static factories enforced on implementing classes | [`08-static-interface-members`](file:///e:/Repos/ts-plus-plus/packages/examples/08-static-interface-members) |
| [**Compile-Time Macros**](#7-compile-time-macros) | `@tspp/plugin-macros` | Stable | Asynchronous compile-time AST macros, hygienic quasiquoting (`$()`), macro expansion budgeting, IDE preview | [`10-macros`](file:///e:/Repos/ts-plus-plus/packages/examples/10-macros) |
| [**Operator Sections**](#8-operator-sections) | `@tspp/plugin-operator-sections` | Stable | Placeholder-based partial application using `_` (e.g., `(_ + 1)`, `(10 - _)`, `values.map(_ * 2)`) | [`11-operator-sections`](file:///e:/Repos/ts-plus-plus/packages/examples/11-operator-sections) |

---

## Detailed Feature Specifications

### 1. Advanced Classes

* **Package**: [`@tspp/plugin-advanced-classes`](file:///e:/Repos/ts-plus-plus/packages/plugins/advanced-classes)
* **Example**: [`packages/examples/12-advanced-classes`](file:///e:/Repos/ts-plus-plus/packages/examples/12-advanced-classes)
* **Description**: Modern object-oriented programming extensions designed to eliminate boilerplate and enforce class hierarchy encapsulation.

**Features**:

* **`field` Property Syntax**: Semi-automatic property declaration with an implicit backing field (`field`) and custom `get()`/`set()` accessors.
* **`object` Singleton Declarations**: First-class singleton instances that also serve as their own type definitions (`object AppConfig { ... }`).
* **`data class`**: Primary constructor syntax with auto-synthesized `copy()`, structural `equals()`, and pretty `toString()`.
* **`with` Expressions**: Non-destructive copy expression for data classes and objects (`with(point, { x: 10 })`).
* **`sealed class`**: Closed type hierarchies restricted to inheritance within the declaring file, enabling full Algebraic Data Types (ADTs) when combined with `object` and `data class`.
* **`final class` & `final` Methods**: Compile-time prevention of subclassing and method overrides.

```typescript
sealed abstract class NetworkResult {
  abstract describe(): string;
  final isTerminal(): boolean { return this !== Loading; }
}

object Loading extends NetworkResult {
  describe() { return "Loading..."; }
}

data class Success(payload: string) extends NetworkResult {
  describe() { return `Data: ${this.payload}`; }
}
```

---

### 2. Modern Syntax

* **Package**: [`@tspp/plugin-modern-syntax`](file:///e:/Repos/ts-plus-plus/packages/plugins/modern-syntax)
* **Example**: [`packages/examples/01-modern-syntax`](file:///e:/Repos/ts-plus-plus/packages/examples/01-modern-syntax)
* **Description**: Value-level functional syntax ergonomics.

**Features**:

* **`let ... in ...` Expressions**: Lexically scoped local expression bindings (`const total = let a = 1, b = 2 in a + b;`).
* **`do { ... }` Blocks**: Multi-statement expression blocks whose completion value is returned.
* **Completion-Valued Function Bodies**: Functions and methods declared with `do { ... }` where the final expression is implicitly returned.
* **`def` Deep-Readonly Bindings**: Immutability by default for values, emitting as standard JS `const`.
* **`use <-` Trailing Closures**: Cleaner syntax for passing callbacks and resource cleanup blocks.

```typescript
const greeting = do {
  const name = "TS++";
  `Hello from ${name}`;
};

function add(a: number, b: number): number do {
  a + b;
}
```

---

### 3. Formal Verification

* **Package**: [`@tspp/plugin-formal-verification`](file:///e:/Repos/ts-plus-plus/packages/plugins/formal-verification)
* **Example**: [`packages/examples/02-formal-verification`](file:///e:/Repos/ts-plus-plus/packages/examples/02-formal-verification)
* **Description**: Automated formal verification integrated directly into the type-checking pipeline, powered by an isolated Z3 SMT solver worker.

**Features**:

* **Function Contracts**: `requires` (preconditions) and `ensures` (postconditions) checked symbolically at introduction and call sites.
* **Proof Points**: `assert:` proof obligations and trusted `assume:` facts.
* **Loop Invariants**: `invariant:` annotations generating initialization and inductive preservation obligations.
* **Refinement Types**: Types refined by predicates (e.g. `type Positive = bigint with { predicate: value > 0n; };`).
* **Arithmetic Models**: Explicit selection between `mathematical-real` and `safe-integer` models to guarantee absence of overflow/division-by-zero.
* **IDE Artifact View**: Visual inspection of generated SMT-LIB scripts and obligation statuses in VS Code.

```typescript
function divide(a: bigint, b: bigint): bigint
  requires b !== 0n
  ensures result * b <= a
{
  return a / b;
}
```

---

### 4. Nominal Types & Algebraic Data Types

* **Package**: [`@tspp/plugin-nominal-types`](file:///e:/Repos/ts-plus-plus/packages/plugins/nominal-types)
* **Examples**: [`packages/examples/03-nominal-types`](file:///e:/Repos/ts-plus-plus/packages/examples/03-nominal-types), [`packages/examples/04-newtype-consumer`](file:///e:/Repos/ts-plus-plus/packages/examples/04-newtype-consumer)
* **Description**: Strong typing abstractions that prevent primitive obsession without runtime performance cost.

**Features**:

* **`newtype` Declarations**: Zero-allocation nominal type wrappers (`newtype UserId = string`). Subtypes are assignable to underlying types, but not vice-versa without explicit constructor calls.
* **Algebraic `data` Tagged Unions**: Nominal sum types with typed variant constructors.
* **`match` Expressions**: Exhaustive pattern matching over `data` constructors with positional destructuring, `if` guards, and `_` fallbacks.

```typescript
newtype UserId = string;
newtype OrderId = string;

data Option<T> = Some(value: T) | None;

const message = match (opt) {
  Some(val) => `Found: ${val}`,
  None => "Nothing here",
};
```

---

### 5. Type Computation, Higher-Kinded & Dependent Types

* **Package**: [`@tspp/plugin-type-computation`](file:///e:/Repos/ts-plus-plus/packages/plugins/type-computation)
* **Examples**: [`05-dependent-types`](file:///e:/Repos/ts-plus-plus/packages/examples/05-dependent-types), [`06-type-computation`](file:///e:/Repos/ts-plus-plus/packages/examples/06-type-computation), [`07-higher-kinded-types`](file:///e:/Repos/ts-plus-plus/packages/examples/07-higher-kinded-types)
* **Description**: Advanced type-level computation kernel based on Martin-Löf type theory (MLTT).

**Features**:

* **Higher-Kinded Types (HKT)**: Kind annotations (`F: Type => Type`), first-class generic interface references, and kind polymorphism.
* **Anonymous Type Constructors**: `<T> =>> Body` expressions that can be passed directly as type arguments.
* **Dependent Types**: Pi types (`(n: Nat) -> Vec<n>`), Sigma types, and indexed type families.
* **Type-level `let` & `match`**: Lexical type bindings and ordered, non-distributive structural type matching.
* **`reify` & `typecase`**: Compile-time reflection producing serialized descriptors and branch selection based on types.

```typescript
type Functor<F: Type => Type> = {
  map<A, B>(fa: F<A>, fn: (a: A) => B): F<B>;
};

type Vec<N: Nat, T> = <N: Nat> =>> ...;
```

---

### 6. Static Interface Members

* **Package**: [`@tspp/plugin-static-interface-members`](file:///e:/Repos/ts-plus-plus/packages/plugins/static-interface-members)
* **Example**: [`packages/examples/08-static-interface-members`](file:///e:/Repos/ts-plus-plus/packages/examples/08-static-interface-members)
* **Description**: Enforces static-side constructor and factory contracts on classes implementing interfaces.

**Features**:

* **Static Interface Contracts**: Declare `static` methods in interfaces that classes must implement.
* **Factory Pattern Enforcement**: Require classes to implement `static create(...)` or `static deserialize(...)`.
* **Clean Boundary**: Static members do not pollute instance types; they are strictly checked during class `implements` verification.

```typescript
interface Serializable {
  static deserialize(json: string): this;
  serialize(): string;
}

class User implements Serializable {
  static deserialize(json: string): User { /* ... */ }
  serialize(): string { /* ... */ }
}
```

---

### 7. Compile-Time Macros

* **Package**: [`@tspp/plugin-macros`](file:///e:/Repos/ts-plus-plus/packages/plugins/macros)
* **Example**: [`packages/examples/10-macros`](file:///e:/Repos/ts-plus-plus/packages/examples/10-macros)
* **Description**: Programmatic compile-time metaprogramming for AST inspection and code generation.

**Features**:

* **Macro Expansion**: Write macros in TypeScript that transform code at compile time.
* **Hygienic Quasiquotes**: Generate new AST trees safely using `$()` interpolation.
* **Sandbox & Budgets**: Sandboxed execution with timeout and recursion budgets to ensure compiler stability.
* **IDE Previews**: Inspect expanded macro code directly in VS Code.

---

### 8. Operator Sections

* **Package**: [`@tspp/plugin-operator-sections`](file:///e:/Repos/ts-plus-plus/packages/plugins/operator-sections)
* **Example**: [`packages/examples/11-operator-sections`](file:///e:/Repos/ts-plus-plus/packages/examples/11-operator-sections)
* **Description**: Functional placeholder-based partial application inspired by Haskell and Scala.

**Features**:

* **Placeholder Syntax (`_`)**: Write terse functional transforms like `(_ + 1)`, `(10 - _)`, `(_ * 2 + 1)`.
* **Zero Runtime Overhead**: Lowered directly at parse time into standard JavaScript arrow functions.

```typescript
const numbers = [1, 2, 3];
const doubled = numbers.map(_ * 2);
const filtered = numbers.filter(_ > 1);
```

---

## Enabling Feature Plugins

To enable any feature in a TS++ project, declare it under `compilerOptions.plugins` in `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "strict": true,
    "plugins": [
      { "name": "@tspp/plugin-advanced-classes", "tspp": true },
      { "name": "@tspp/plugin-modern-syntax", "tspp": true },
      { "name": "@tspp/plugin-operator-sections", "tspp": true }
    ]
  },
  "include": ["src/**/*.tspp"]
}
```

Both the command-line compiler (`tspp`) and the language server (`tsppserver`) automatically discover and activate declared capsules in dependency order.
