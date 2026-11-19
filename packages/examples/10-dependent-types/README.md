# 10-dependent-types — 依赖类型与命题即类型 / Dependent Types & Propositions as Types

本目录循序渐进地介绍 TS++ 的**依赖类型系统（Dependent Type System）**。
在传统类型系统中，函数只能做到“值 $\to$ 值（普通函数）”、“类型 $\to$ 值（泛型）”或“类型 $\to$ 类型（高阶类型）”；而**依赖类型允许“值 $\to$ 类型”**——即一个类型的定义可以直接取决于某个具体的值（如布尔值或自然数），并且可以在编译期表达数学命题与形式化证明（Curry-Howard 同构，“命题即类型”）。

This directory provides a step-by-step introduction to **Dependent Types** in TS++.
While traditional type systems support "Value $\to$ Value" (functions), "Type $\to$ Value" (generics), and "Type $\to$ Type" (type operators), **Dependent Types enable "Value $\to$ Type"** — allowing types to depend directly on concrete values (such as booleans or natural numbers) and enabling compile-time mathematical propositions and proofs via the Curry-Howard Isomorphism ("Propositions as Types").

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **类型宇宙层级 / Type Universes** | `export type UniverseZero: Type1 = Type0;` | 将类型分层为 `Type0 : Type1 : Type2 ...`，让类型本身也可以作为一等公民传递，同时避免自指悖论。<br/>Stratifies types into `Type0 : Type1 : Type2 ...` so types can be passed as first-class values without self-referential paradoxes. |
| **依赖函数类型 (Pi 类型) / Pi Types** | `{A: Type0} -> (value: A) -> A` | 将隐式类型参数 `{A: Type0}` 与显式值参数 `(value: A)` 统一到一条函数签名链中，后续参数类型与返回类型可依赖前面的参数。<br/>Unifies implicit `{A: Type0}` and explicit `(value: A)` binders so later parameter and return types can depend on earlier parameters. |
| **部分显式类型传参 / Partial Explicit Type Args** | `selectRight<auto, string>(1, "right")` | 使用 `auto` 占位符让编译器自动推导部分隐式类型参数，同时显式指定其余类型参数。<br/>Uses `auto` placeholders to let the compiler infer selected implicit type arguments while explicitly fixing others. |
| **依赖布尔分支 / Dependent `Bool` & `If`** | `If<True, <b: Bool> =>> Type0, string, number>` | 根据布尔值 `True` 或 `False` 在编译期直接计算出不同的结果类型。<br/>Computes different result types at compile time based on a boolean value (`True` or `False`). |
| **皮亚诺自然数与数学归纳法 / Peano `Nat` & Induction** | `Succ<Zero>`, `NatAdd<One, One>`, `NaturalNumberInduction` | 在类型层面表示自然数与算术加法，并用 Pi 类型直接表达数学归纳法原理。<br/>Represents natural numbers and addition at the type level, expressing Mathematical Induction as a Pi type. |
| **相等性命题与证明 / Equality `Eq` & `Refl`** | `Eq<Nat, Four, Succ<Succ<Two>>>`, `Refl<Nat, Four>` | 将“两个值相等”表示为类型 `Eq<A, x, y>`，通过编译期计算化简与自反性 `Refl`（以及路径归纳法 `PathInduction`）完成静态定理证明。<br/>Encodes equality as a proposition type `Eq<A, x, y>`, proved via compile-time normalization, `Refl`, and `PathInduction`. |
| **依赖对类型 (Sigma 类型) / Sigma Types** | `Sigma<(value: Nat) -> Eq<Nat, value, N>>` | 将一个值 `x` 与依赖于该值的证明/数据 `P(x)` 打包成对（对应逻辑中的存在量词 $\exists x.\, P(x)$），支持 `Pair`、`First`、`Second`。<br/>Pairs a witness value `x` with a proof/value of type `P(x)` (existential quantification $\exists x.\, P(x)$), with `Pair`, `First`, and `Second`. |
| **类型具象化与编译期分支 / `reify` & `typecase`** | `reify Array<string>`, `typecase desc { ... }` | 将编译期类型转化为运行时可读取的描述符对象，并在编译期通过模式匹配（含 `infer` 捕获）选择对应的值表达式。<br/>Reifies compile-time types into runtime descriptor objects and selects value expressions via compile-time pattern matching. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-basics.tspp`](./src/01-basics.tspp)** — 四种依赖关系图景、类型宇宙层级（`Type0 : Type1 : Type2`）、依赖函数类型（Pi 类型）、隐式/显式参数绑定与 `<auto, T>` 部分显式传参。
   Covers the four forms of dependency, type universes (`Type0 : Type1 : Type2`), Pi types, implicit/explicit binders, and `<auto, T>` partial instantiation.
2. **[`src/02-booleans.tspp`](./src/02-booleans.tspp)** — 布尔类型 `Bool`（`True` / `False`）、动机函数（Motive）以及依赖条件消去器 `If`。
   Covers `Bool` (`True` / `False`), motives, and the dependent conditional eliminator `If`.
3. **[`src/03-type-matching.tspp`](./src/03-type-matching.tspp)** — 类型级模式匹配 `match`、`infer` 子类型提取与依赖类型族（Type Families）。
   Covers type-level `match`, `infer` extraction, and constructing Type Families with Pi types.
4. **[`src/04-naturals.tspp`](./src/04-naturals.tspp)** — 皮亚诺自然数（`Nat`, `Zero`, `Succ`, `NatAdd`）与自然数数学归纳法原理 `NaturalNumberInduction`。
   Covers Peano natural numbers (`Nat`, `Zero`, `Succ`, `NatAdd`) and `NaturalNumberInduction`.
5. **[`src/05-equality.tspp`](./src/05-equality.tspp)** — 命题即类型（Curry-Howard 同构）、相等性命题 `Eq`、编译期计算相等、自反性证明 `Refl` 与路径归纳法 `PathInduction`。
   Covers Propositions as Types, propositional equality `Eq`, definitional equality by computation, `Refl`, and `PathInduction`.
6. **[`src/06-sigma.tspp`](./src/06-sigma.tspp)** — 依赖对类型（Sigma 类型 `Sigma<(x: A) -> P(x)>`）、存在命题证人构造 `Pair` 以及投影运算 `First` / `Second`。
   Covers Sigma types (`Sigma<(x: A) -> P(x)>`), dependent pair construction `Pair`, and projections `First` / `Second`.
7. **[`src/07-boundaries.tspp`](./src/07-boundaries.tspp)** — 依赖类型族与标准 TypeScript 对象类型、联合类型的无缝组合。
   Covers combining dependent type families with standard TypeScript object and union types.
8. **[`src/08-runtime-reification.tspp`](./src/08-runtime-reification.tspp)** — `reify` 类型描述符具象化与 `typecase` 编译期类型模式匹配（含 `infer` 类型捕获）。
   Covers `reify` type descriptors and compile-time `typecase` pattern matching with `infer` captures.
9. **[`src/09-imported-aliases.tspp`](./src/09-imported-aliases.tspp)** — 跨文件导入类型级自然数、用 `Refl` 证明 `2 + 2 = 4`、值级类型函数 `Nat => Nat` 与按值索引的类型构造器 `Sized<N>`。
   Covers cross-file natural number computation, proving `2 + 2 = 4` with `Refl`, `Nat => Nat` functions, and value-indexed `Sized<N>`.
10. **[`src/10-gadt-interpreter.tspp`](./src/10-gadt-interpreter.tspp)** — 带结果类型索引的表达式、无需断言的解释器，以及用自定义 `data` 构造器和 `match` 打包、拆解运行时才确定的类型。
    Covers indexed expression constructors, an assertion-free interpreter, and user-defined existential pairs consumed with ordinary `match`. Host functions keep this example separate from variable binding and environments.
11. **[`src/11-context-interpreter.tspp`](./src/11-context-interpreter.tspp)** — 上下文索引、变量位置证据、异构环境和 lambda 求值；通过延迟构造递归表达式计算阶乘。
    Adds context indices, de Bruijn variable proofs, heterogeneous environments, lambda evaluation, and a delayed recursive factorial expression.
12. **[`src/12-well-typed-interpreter.tspp`](./src/12-well-typed-interpreter.tspp)** — 独立完整示例：变量、lambda、阶乘与携带运行时类型证据的动态返回值，无需导入前面的文件。
    A standalone interpreter combining contexts, variables, lambdas, factorial, and runtime-selected integer, boolean, or function results with indexed type witnesses.

这三个解释器示例同时启用 `type-computation` 和 `nominal-types`。运行时依赖对通过用户定义的 `Some`、`Evaluated` 构造器和普通 `match` 表达；无需内置 `pack` 或 `unpack`。`lookup` 根据变量证据排除空环境分支，求值函数不使用类型断言。类型层的 `Sigma`、`Pair` 示例仍用于 MLTT 计算；运行时索引关联由 GADT 检查保留。示例展示类型安全，不检查任意递归函数的终止性。

All three interpreters enable `type-computation` and `nominal-types`. Runtime dependent pairs use user-defined constructors
and ordinary `match`; MLTT `Sigma` and `Pair` remain type-level computations. Variable proofs make empty-environment
branches unreachable, and the evaluators require no type assertions. General termination checking is outside these examples.

`add` 只需标注整个表达式的类型，构造器就能向内传递上下文、参数与结果索引，并推导 `Op` 回调和 `Stop` / `Pop` 的类型。阶乘保留一个局部变量类型标注及递归调用的上下文参数，其他构造器无需手写类型实参。缺少足够上下文时仍需标注；推导不会从后续语句倒推，也不会反解任意类型族。

Annotating the whole `add` expression supplies the indices for nested constructors, operator callbacks, and variable
proofs. Factorial retains one local expression annotation and the recursive call's context argument. Ambiguous calls
still need annotations; inference does not use later statements or invert arbitrary type families.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
