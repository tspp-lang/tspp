# 12-formal-verification — 编译期形式化验证与逻辑契约 / Compile-Time Formal Verification & Logical Contracts

本目录演示 TS++ 的**编译期形式化验证（Formal Verification）**体系。与只能抽样测试少数输入的单元测试、或等到运行时才报错的 `if` 断言不同，形式化验证会在**编译阶段**将代码与契约转化为数学公式，直接证明程序性质对**所有可能的输入值**都必然成立；一旦存在任何反例，编译器会直接报错并指出具体反例。

This directory demonstrates **compile-time formal verification** in TS++. Unlike unit tests (which only sample a few inputs) or runtime `if` checks (which only fail when executed), formal verification translates code and contracts into mathematical formulas at **compile time**, proving that program properties hold for **every possible input** and reporting a concrete counterexample whenever a proof fails.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`assert:` 静态证明点** | `assert: next > 0n;` | 要求编译器在当前位置静态证明布尔条件对所有可能路径恒成立，无运行时开销。<br/>Asks the compiler to statically prove a condition holds along all paths reaching that point, with zero runtime overhead. |
| **`assume:` 已知前提假设** | `assume: value >= 0n;` | 向验证器补充一条外部已保证为真的前提条件，供后续语句推导使用。<br/>Supplies a known-true premise for subsequent compile-time reasoning. |
| **`requires:` / `ensures:` 函数契约** | `function f(x: bigint) with { requires: x >= 0n; ensures: result > x; }: bigint` | `requires:` 约束调用方必须满足的输入条件；`ensures:` 承诺返回值 `result` 必然满足的性质。<br/>`requires:` specifies caller preconditions checked at call sites; `ensures:` specifies return guarantees verified across all `return` paths. |
| **`invariant:` 循环不变式** | `while (i < n) with { invariant: [i >= 0n, i <= n]; } { ... }` | 通过数学归纳法（初值成立 + 单步保持 + 退出推导）静态证明任意次数的循环。<br/>Proves loops for arbitrary iteration counts via mathematical induction (initialization, preservation, and exit). |
| **`predicate:` 精化类型** | `type Positive = bigint with { predicate: value > 0n; };` | 在基础类型上附加逻辑谓词，将满足条件的值定义为子类型，并自动推导逻辑蕴含关系。<br/>Attaches a logical predicate to a base type and automatically proves subtype implications between refined types. |
| **`numberModel:` 数值模型** | `with { numberModel: "mathematical-real" \| "safe-integer"; }` | 显式指定 `number` 按连续数学实数推导，还是按带上下界溢出检查的安全整数（$[-2^{53}+1, 2^{53}-1]$）推导。<br/>Selects whether `number` is reasoned about as continuous mathematical reals or as overflow-checked safe integers. |
| **`class ... with { invariant: ... }` 类不变式** | `class Account with { invariant: balance >= 0n; } { ... }` | 证明构造函数建立初始状态合法性，且每个方法在正常返回或异常抛出时都保持该状态性质。<br/>Proves that constructors establish and all methods preserve an object's state invariant across normal and throwing exits. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-proof-points.tspp`](./src/01-proof-points.tspp)** — 编译期数学证明的基本概念、静态证明点 `assert:`、前提假设 `assume:` 以及反例报错拦截。
   Covers compile-time mathematical proofs, `assert:` proof points, `assume:` premises, and counterexample interception.
2. **[`src/02-function-contracts.tspp`](./src/02-function-contracts.tspp)** — 函数前置条件 `requires:`、后置条件 `ensures:`、多分支返回证明与跨函数契约传递。
   Covers function preconditions (`requires:`), postconditions (`ensures:`), multi-branch return proofs, and compositional contract chaining.
3. **[`src/03-loop-invariants.tspp`](./src/03-loop-invariants.tspp)** — 为什么循环需要不变式，以及如何通过 `invariant:` 用数学归纳法证明循环。
   Covers why loops need invariants and how `invariant:` proves loops via mathematical induction.
4. **[`src/04-refinement-types.tspp`](./src/04-refinement-types.tspp)** — 使用 `with { predicate: ... }` 定义精化类型（如 `Positive`、`NonNegative`）及子类型自动蕴含证明。
   Covers refinement types (`with { predicate: ... }`) and automatic logical subtype implication.
5. **[`src/05-program-semantics.tspp`](./src/05-program-semantics.tspp)** — 整数除法向零截断语义、余数符号规律以及编译期静态除零拦截。
   Covers truncation-toward-zero integer division, remainder sign laws, and static division-by-zero checks.
6. **[`src/06-real-number-model.tspp`](./src/06-real-number-model.tspp)** — `numberModel: "mathematical-real"` 连续数学实数模型下的代数与区间推导。
   Covers continuous real-number reasoning under `numberModel: "mathematical-real"`.
7. **[`src/07-safe-integer-model.tspp`](./src/07-safe-integer-model.tspp)** — `numberModel: "safe-integer"` 安全整数模型下的算术溢出边界检查。
   Covers safe-integer bounds and automatic no-overflow obligations under `numberModel: "safe-integer"`.
8. **[`src/08-structured-control-flow.tspp`](./src/08-structured-control-flow.tspp)** — 可辨识联合类型（Discriminated Unions）与多分支路径敏感（Path-Sensitive）契约证明。
   Covers discriminated unions and path-sensitive verification across nested branches and early returns.
9. **[`src/09-recursive-data.tspp`](./src/09-recursive-data.tspp)** — 递归代数数据类型（`data`）构造器与 `switch` 分支上的契约验证。
   Covers contract verification over recursive algebraic data types (`data`) and `switch` branches.
10. **[`src/10-logic-library.tspp`](./src/10-logic-library.tspp)** — 可复用的全称量化谓词（`forall`）、递归逻辑函数（`defineRecursiveFunction`）与公理（`axiom`）。
    Covers reusable universally quantified predicates (`forall`), recursive logic functions, and axioms.
11. **[`src/11-class-invariants.tspp`](./src/11-class-invariants.tspp)** — 类不变式（`invariant:`）的构造函数建立、方法保持以及异常守卫路径验证。
    Covers class invariants (`invariant:`) established by constructors and preserved across normal and throwing method exits.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
