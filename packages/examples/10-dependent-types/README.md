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
| **依赖函数类型 (Pi 类型) / Pi Types** | `(A: Type0, value: A) => A` | 写法就是胖箭头函数类型，后续参数类型与返回类型可依赖前面的参数；类型参数写在 `<A>` 里会被擦除，写在圆括号里则在运行时以 `reify` 描述符传入。<br/>Written as a fat-arrow function type whose later parameter and return types can depend on earlier parameters; a type in `<A>` is erased, while one in the parentheses is passed at runtime as a `reify` descriptor. |
| **部分显式类型传参 / Partial Explicit Type Args** | `selectRight<auto, string>(1, "right")` | 使用 `auto` 占位符让编译器自动推导部分类型参数，同时显式指定其余类型参数。<br/>Uses `auto` placeholders to let the compiler infer selected type arguments while explicitly fixing others. |
| **依赖布尔分支 / Dependent `Bool` & `If`** | `If<True, <b: Bool> =>> Type0, string, number>` | 根据布尔值 `True` 或 `False` 在编译期直接计算出不同的结果类型。<br/>Computes different result types at compile time based on a boolean value (`True` or `False`). |
| **皮亚诺自然数与数学归纳法 / Peano `Nat` & Induction** | `Succ<Zero>`, `NatAdd<One, One>`, `NaturalNumberInduction` | 在类型层面表示自然数与算术加法，并用 Pi 类型直接表达数学归纳法原理。<br/>Represents natural numbers and addition at the type level, expressing Mathematical Induction as a Pi type. |
| **相等性命题与证明 / Equality `Eq` & `Refl`** | `Eq<Nat, Four, Succ<Succ<Two>>>`, `Refl<Nat, Four>` | 将“两个值相等”表示为类型 `Eq<A, x, y>`，通过编译期计算化简与自反性 `Refl`（以及路径归纳法 `PathInduction`）完成静态定理证明。<br/>Encodes equality as a proposition type `Eq<A, x, y>`, proved via compile-time normalization, `Refl`, and `PathInduction`. |
| **依赖对类型 (Sigma 类型) / Sigma Types** | `Sigma<(value: Nat) => Eq<Nat, value, N>>` | 将一个值 `x` 与依赖于该值的证明/数据 `P(x)` 打包成对（对应逻辑中的存在量词 $\exists x.\, P(x)$），支持 `Pair`、`First`、`Second`。<br/>Pairs a witness value `x` with a proof/value of type `P(x)` (existential quantification $\exists x.\, P(x)$), with `Pair`, `First`, and `Second`. |
| **类型具象化与编译期分支 / `reify` & `typecase`** | `reify Array<string>`, `typecase desc { ... }` | 将编译期类型转化为运行时可读取的描述符对象，并在编译期通过模式匹配（含 `infer` 捕获）选择对应的值表达式。<br/>Reifies compile-time types into runtime descriptor objects and selects value expressions via compile-time pattern matching. |
| **运行时类型证据 / Runtime Type Evidence** | `(A: Type, value: A) => string`, `Pack: (A: Type, value: A) => AnyValue` | 把类型作为参数传到运行时；对描述符 `typecase` 时生成真正的运行时分支，并在分支内细化依赖该类型的值。描述符 `Reified<T>` 只能由编译器生成，无法伪造。<br/>Passes types to runtime as parameters; a `typecase` on such a descriptor becomes a real runtime branch that refines the values depending on the type. Descriptors (`Reified<T>`) are made only by the compiler and cannot be forged. |
| **广义代数数据类型与局部索引收窄 / Indexed `data` (GADTs) & Dependent `match`** | `data Expr<T extends Ty> { Val: (v: bigint) => Expr<"int">, ... }` | 允许每个 `data` 构造器指定具体的返回类型索引；在 `match` 分支内根据构造器索引自动收窄返回类型族（如 `InterpTy<T>`）并剔除不可能的构造器分支。<br/>Lets each `data` constructor specify its own result index; `match` arms refine indexed result families (like `InterpTy<T>`) locally and omit provably unreachable constructors. |
| **存在包装构造器与运行时依赖对 / Existential Constructors & Runtime Dependent Pairs** | `data SomeExpr { Some: <T extends Ty>(tag: T, expr: Expr<T>) => SomeExpr }` | 构造器可声明未出现在结果类型中的局部类型参数 `T`，将类型标签/证据与依赖该索引的值打包为运行时依赖对，并通过普通 `match` 安全拆包（无需内置 `pack` / `unpack`）。<br/>Constructors can quantify over local type parameters hidden from the result type, packaging a runtime tag or witness with an indexed payload and unpacking them safely via ordinary `match`. |
| **上下文索引、变量位置证据与构造器上下文推导 / Context Indices, De Bruijn Proofs & Contextual Constructor Inference** | `HasType<C, T>`, `Env<C>`, `Lam(Lam(Op(..., Var(Stop()), Var(Pop(Stop())))))` | 用类型元组 `Context` 记录作用域内所有变量类型，以 `Stop` / `Pop` 构造编译期越界免疫的德布鲁因（de Bruijn）变量证据；并在外层类型标注下向内自动推导嵌套构造器、回调参数与变量证据的索引。<br/>Tracks in-scope variable types in a `Context` tuple with `Stop` / `Pop` de Bruijn membership proofs, and propagates expected result indices inward across nested constructors and callbacks. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-basics.tspp`](./src/01-basics.tspp)** — 四种依赖关系图景、类型宇宙层级（`Type0 : Type1 : Type2`）、依赖函数类型（Pi 类型）、类型参数的两种传法（擦除的 `<A>` 与运行时传入的 `(A: Type0)`）以及 `<auto, T>` 部分显式传参。
   Covers the four forms of dependency, type universes (`Type0 : Type1 : Type2`), Pi types, the two ways to pass a type (erased `<A>` and runtime `(A: Type0)`), and `<auto, T>` partial instantiation.
2. **[`src/02-booleans.tspp`](./src/02-booleans.tspp)** — 布尔类型 `Bool`（`True` / `False`）、动机函数（Motive）以及依赖条件消去器 `If`。
   Covers `Bool` (`True` / `False`), motives, and the dependent conditional eliminator `If`.
3. **[`src/03-type-matching.tspp`](./src/03-type-matching.tspp)** — 类型级模式匹配 `match`、`infer` 子类型提取与类型族（Type Families）。
   Covers type-level `match`, `infer` extraction, and Type Families built with `match`.
4. **[`src/04-naturals.tspp`](./src/04-naturals.tspp)** — 皮亚诺自然数（`Nat`, `Zero`, `Succ`, `NatAdd`）与自然数数学归纳法原理 `NaturalNumberInduction`。
   Covers Peano natural numbers (`Nat`, `Zero`, `Succ`, `NatAdd`) and `NaturalNumberInduction`.
5. **[`src/05-equality.tspp`](./src/05-equality.tspp)** — 命题即类型（Curry-Howard 同构）、相等性命题 `Eq`、编译期计算相等、自反性证明 `Refl` 与路径归纳法 `PathInduction`。
   Covers Propositions as Types, propositional equality `Eq`, definitional equality by computation, `Refl`, and `PathInduction`.
6. **[`src/06-sigma.tspp`](./src/06-sigma.tspp)** — 依赖对类型（Sigma 类型 `Sigma<(x: A) => P(x)>`）、存在命题证人构造 `Pair` 以及投影运算 `First` / `Second`。
   Covers Sigma types (`Sigma<(x: A) => P(x)>`), dependent pair construction `Pair`, and projections `First` / `Second`.
7. **[`src/07-boundaries.tspp`](./src/07-boundaries.tspp)** — 类型族、依赖函数类型与标准 TypeScript 对象类型、联合类型的无缝组合。
   Covers combining type families and dependent function types with standard TypeScript object and union types.
8. **[`src/08-runtime-reification.tspp`](./src/08-runtime-reification.tspp)** — `reify` 类型描述符具象化与 `typecase` 编译期类型模式匹配（含 `infer` 类型捕获）。
   Covers `reify` type descriptors and compile-time `typecase` pattern matching with `infer` captures.
9. **[`src/09-imported-aliases.tspp`](./src/09-imported-aliases.tspp)** — 跨文件导入类型级自然数、用 `Refl` 证明 `2 + 2 = 4`、值级类型函数 `Nat => Nat` 与按值索引的类型构造器 `Sized<N>`。
   Covers cross-file natural number computation, proving `2 + 2 = 4` with `Refl`, `Nat => Nat` functions, and value-indexed `Sized<N>`.
10. **[`src/10-gadt-interpreter.tspp`](./src/10-gadt-interpreter.tspp)** — 广义代数数据类型（GADT / 按结果类型索引的 `data` 构造器）、结合类型级 `match` 的无断言求值器 `interp`、用存在构造器 `Some` / `Evaluated` 与普通 `match` 表达运行时依赖对，以及编译期错误边界检查（`@ts-expect-error`）。
    Covers GADT indexed expression constructors, an assertion-free evaluator returning a type-level `match` family `InterpTy<T>`, user-defined existential pairs (`SomeExpr` / `SomeValue`) unpacked with ordinary `match`, and `@ts-expect-error` boundary checks.
11. **[`src/11-context-interpreter.tspp`](./src/11-context-interpreter.tspp)** — 词法作用域上下文索引 `Context`、德布鲁因（de Bruijn）变量位置证据 `HasType<C, T>`（`Stop` / `Pop`）、异构运行时环境 `Env<C>`（在 `lookup` 中静态排除空环境 `Nil` 分支）、嵌套 `Lam` / `Op` 构造器的上下文索引自动推导、用 `Delay` 延迟构造递归阶乘 AST，以及编译期错误边界检查（`@ts-expect-error`）。
    Covers lexical `Context` tuple indices, de Bruijn variable membership proofs `HasType<C, T>` (`Stop` / `Pop`), heterogeneous environments `Env<C>` (statically ruling out `Nil` in `lookup`), contextual constructor inference across nested `Lam` / `Op` calls, delayed recursive AST construction (`factorial`), and `@ts-expect-error` boundary checks.
12. **[`src/12-well-typed-interpreter.tspp`](./src/12-well-typed-interpreter.tspp)** — 独立完整的良类型解释器综合实战（Idris 风格）：将上下文索引 AST、词法环境、高阶函数、延迟递归阶乘与运行时类型证据 GADT `TypeWitness<T>`（`IntegerType` / `BooleanType` / `FunctionType`）整合在单个可独立运行的文件中，演示通过双重 `match` 根据运行时类型证据精确收窄伴随值的类型，并附带 `@ts-expect-error` 边界验证。
    A standalone Idris-style well-typed interpreter combining contexts, de Bruijn variables, heterogeneous environments, lambdas, delayed recursive factorial, and runtime `TypeWitness<T>` GADT tags (`IntegerType` / `BooleanType` / `FunctionType`) that refine their paired payload value upon nested `match`, complete with `@ts-expect-error` boundary checks.
13. **[`src/13-runtime-evidence.tspp`](./src/13-runtime-evidence.tspp)** — 运行时类型证据：用 `(A: Type)` 把类型传进函数、对描述符做运行时 `typecase` 并细化值、“属于而非等于”的写入限制、不可伪造的 `Reified<T>`、用 `Pack: (A: Type, value: A) => AnyValue` 构造异构列表，以及以长度为值索引的依赖对 `Sized`。
    Covers runtime type evidence: passing a type with `(A: Type)`, runtime `typecase` that refines values, membership rather than equality for writes, unforgeable `Reified<T>`, a heterogeneous list built from `Pack: (A: Type, value: A) => AnyValue`, and `Sized`, a dependent pair indexed by a length value.

---

## 索引数据类型（GADT）与解释器示例说明 / Notes on Indexed Data (GADTs) & the Interpreter Examples

`10`、`11`、`12` 三个解释器示例同时启用了 `type-computation` 与 `nominal-types` 插件，展示了编译期类型级计算与运行时名义代数数据类型的深度协同：
- **无需内置 `pack` / `unpack` 的运行时依赖对**：前文 `06-sigma.tspp` 中的 `Sigma` 与 `Pair` 用于编译期 MLTT 类型层计算；而在运行时，只需编写带有隐藏类型参数的普通 `data` 构造器（如 `Some: <T extends Ty>(tag: T, expression: Expr<T>) => SomeExpr`），即可将类型证据与依赖该类型的值打包在一起，并用普通 `match` 安全拆包，隐藏索引由 GADT 检查器自动关联并防止逃逸。构造器写成 `Pack: (A: Type, value: A) => AnyValue` 时，类型本身会作为描述符一起保存，打开后可以用 `typecase` 在运行时认出它（见 `13-runtime-evidence.tspp`）。
- **静态排除不可能分支与零类型断言**：在 `11` 和 `12` 的 `lookup(proof, environment)` 中，一旦匹配了 `Stop` 或 `Pop`，编译器即可由 `HasType<readonly [T, ...R], T>` 推知环境索引 `C` 绝不可能是空元组 `readonly []`，因此在内层 `match environment` 中无需编写 `Nil` 分支即可通过穷尽性检查，整个求值器无需任何 `as` 类型断言。
- **由外向内与同级参数的构造器索引推导**：标注了外层目标类型（如 `add: Expr<readonly [], Fun<"int", Fun<"int", "int">>>`）后，期望的上下文、参数与结果索引会自动向内传递给嵌套的 `Lam`、`Op`、`Var`、`Stop()` 和 `Pop(Stop())`，同时兄弟参数也会将索引贡献给 `Op` 的回调函数参数 `(left, right)`。递归函数 `factorial` 仅需保留一处局部变量类型标注 `argument: Expr<Body, "int">` 与递归调用的 `<Body>` 上下文参数，其余构造器均无需手写类型实参。（注：推导仅基于当前表达式的期望类型与同级实参，不会从后续语句倒推，也不会反解非单射的任意类型族；示例聚焦于静态类型安全，不对任意递归函数做停机性证明。）

The three interpreter examples (`10`, `11`, `12`) enable both `type-computation` and `nominal-types` to showcase how type-level computation and nominal GADTs work together:
- **Runtime dependent pairs without built-in `pack` / `unpack`**: While MLTT `Sigma` and `Pair` (`06-sigma.tspp`) perform type-level computations, runtime dependent pairs are expressed directly as user-defined `data` constructors with hidden type parameters (such as `Some` and `Evaluated`) and consumed with ordinary `match`, with index correlation and escape prevention enforced by the GADT checker. Written as `Pack: (A: Type, value: A) => AnyValue`, a constructor also keeps the type itself as a descriptor, which `typecase` can recognize at runtime once the value is opened (see `13-runtime-evidence.tspp`).
- **Unreachable-branch pruning & assertion-free evaluation**: In `lookup(proof, environment)`, matching `Stop` or `Pop` refines the context index `C` to a non-empty tuple `readonly [..., ...R]`, allowing `match environment` to omit the impossible `Nil` branch while remaining exhaustive. Neither `lookup` nor `interp` uses any type assertions.
- **Top-down and sibling contextual constructor inference**: Annotating an outer expression (such as `add`) propagates expected context, argument, and result indices inward to nested constructors (`Lam`, `Op`, `Var`, `Stop()`, `Pop(Stop())`) and operator callbacks. The recursive `factorial` function retains only one local variable annotation (`argument: Expr<Body, "int">`) and the `<Body>` context argument on the recursive call. Ambiguous calls without sufficient expected-type context still require explicit annotations; inference does not look ahead to later statements or invert arbitrary type families, and general termination checking is outside the scope of these examples.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
