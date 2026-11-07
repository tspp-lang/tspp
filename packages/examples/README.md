# TS++ 示例与教程指南 / TS++ Examples & Tutorial Guide

本目录汇集了 TS++ 语言全部核心特性的分步交互式教程。每个编号子目录都是一个独立的示例包，源码统一位于各自目录的 `src/` 下，并配有完整的中英双语概念导读、语法演示与编译期静态检查反例（`@ts-expect-error`）。

This directory contains step-by-step interactive tutorials covering the core language features of TS++. Each numbered subdirectory is an independent package with bilingual explanations, syntax demonstrations, and compile-time boundary checks (`@ts-expect-error`) under `src/`.

---

## 一、 组织思路与五大渐进阶段 / Organization Philosophy & Five Learning Stages

为了让不同背景的开发者都能顺畅地理解 TS++，我们将全部 14 个示例按照**认知难度与概念依赖关系**由浅入深划分为**五个阶段**：

To provide a smooth learning curve without conceptual jumps, all 14 examples are organized in **five progressive stages** ordered by prerequisite concepts and cognitive depth:

### 第一阶段：日常表达式与面向对象语法（零门槛上手）
### Stage 1: Everyday Expression & Class Syntax (`01` ~ `04`)
从最贴近日常直觉的值级语法和类特性入手，不需要任何类型论背景即可立刻上手：
Start with value-level expressions and class ergonomics that require no type-theory background:
- **[`01-modern-syntax`](./01-modern-syntax)** — **面向表达式的编程**：使用 `let ... in` 局部绑定、`do { ... }` 求值块与 `do` 函数体消除临时可变变量；使用 `use <-` 尾闭包绑定拍平多层嵌套回调；使用 `def` 声明深度只读数据。
  Expression-oriented `let ... in` bindings, `do { ... }` completion blocks, `do` function bodies, `use <-` trailing closures, and `def` deep-readonly declarations.
- **[`02-operator-sections`](./02-operator-sections)** — **运算符与属性切片**：使用 `_` 占位符快速编写极简函数表达式（如 `(_ + 1)`、`(10 - _)`、`(_ / _)`、`(_.name)`）。
  Placeholder-based operator and member sections using `_`, such as `(_ + 1)`, `(10 - _)`, `(_ / _)`, and `(_.name)`.
- **[`03-advanced-classes`](./03-advanced-classes)** — **现代类与封闭继承层次**：使用 `field` 声明自带隐式存储的访问器属性、使用 `object` 声明单例、使用 `data class` 与 `with` 处理不可变值对象，并通过 `sealed class` 与 `final` 构建受控的封闭类层次。
  `field` backing properties, `object` singletons, `data class`, `with` copy expressions, `sealed class` hierarchies, and `final` modifiers.
- **[`04-static-interface-members`](./04-static-interface-members)** — **接口中的静态成员契约**：在 `interface` 中同时声明 `static` 属性、静态工厂方法（如 `static deserialize(): this`）与实例方法契约。
  Declaring `static` property and factory contracts alongside instance members inside interfaces.

---

### 第二阶段：名义类型、代数数据类型与类型类（数据建模与特设多态）
### Stage 2: Nominal Types, Algebraic Data & Typeclasses (`05` ~ `07`)
从“如何更精确地定义数据结构”与“如何将数据类型与能力实现解耦”两个维度提升建模能力：
Strengthen data modeling and decouple data definitions from capability implementations:
- **[`05-nominal-types`](./05-nominal-types)** — **名义类型与代数数据类型（ADT）**：通过 `newtype` 防止相同底层类型的值被意外混用；通过 `data` 定义代数和类型（如 `Option<T>`、`Either<L, R>`），并配合 `match` 进行编译期穷尽模式匹配与守卫过滤。
  `newtype` nominal wrappers, algebraic `data` sum types, and exhaustive `match` pattern matching with `if` guards.
- **[`06-newtype-consumer`](./06-newtype-consumer)** — **跨包名义类型消费**：演示当 `05-nominal-types` 作为库发布后，下游包如何导入并保持 `newtype` 与 `data` 的名义区分度及模式匹配穷尽性。
  Consuming `newtype` and `data` declarations across package boundaries while preserving nominal identity.
- **[`07-typeclasses`](./07-typeclasses)** — **类型类与隐式上下文**：讲解类型类（`typeclass`）相比传统面向对象 `interface` 的优势——支持在类型外部用 `impl` 为已有类型（如 `number`）扩展能力、用 `where` 声明函数约束与泛型自动派生，以及用 `@{ ... }` 在调用处显式切换实现。
  `typeclass` contracts, external `impl` definitions, `where` constraints, explicit `@{ ... }` overrides, and inherent extension methods.

---

### 第三阶段：类型系统进阶三部曲（从类型计算、高阶类型到依赖类型）
### Stage 3: The Type Cube Trilogy (`08` ~ `10`)
这是理解 TS++ 高阶类型系统的核心阶梯，**强烈建议严格按照 `08 -> 09 -> 10` 的顺序依次阅读**：
This trilogy forms the conceptual staircase of TS++'s advanced type system. **We strongly recommend reading `08 -> 09 -> 10` in exact order**:
1. **[`08-type-computation`](./08-type-computation)** — **第一阶：结构化类型级计算（Type $\to$ Type 基础）**
   告别晦涩的嵌套条件三元类型（`T extends ... ? ... : ...`），学习如何在类型层面使用 `let ... in` 局部绑定、`match T { ... }` 结构化模式匹配以及 `<T> =>> ...` 匿名类型函数。
   Structured type-level computation with `let ... in` bindings, ordered `match T { ... }` pattern matching, and `<T> =>> ...` anonymous type lambdas.
2. **[`09-higher-kinded-types`](./09-higher-kinded-types)** — **第二阶：类型的分类（Kind）与高阶类型（Higher-Kinded Types）**
   从“为什么普通 TS 不能把未传参的 `Array` 作为泛型参数传递”讲起，认识类型的签名（`Type0`、`Type => Type`、`(Type, Type) => Type`、`Type1`），学习如何把类型构造器作为参数传递并编写统一的 `Functor<Container: Type => Type>`。
   Introduces Kinds (`Type0`, `Type => Type`, `(Type, Type) => Type`), passing unapplied generic type constructors as arguments, and abstracting over containers with `Functor`.
3. **[`10-dependent-types`](./10-dependent-types)** — **第三阶：依赖类型与命题即类型（Value $\to$ Type 顶点）**
   在掌握前两阶后，正式进入“类型依赖于具体值”的领域：从类型宇宙层级（`Type0 : Type1 : Type2`）与依赖函数（$\Pi$ 类型）出发，逐步深入依赖布尔分支 `If`、皮亚诺自然数（`Nat`）与数学归纳法、柯里-霍华德同构（命题即类型）与相等性证明（`Eq` / `Refl` / `PathInduction`）、依赖对类型（$\Sigma$ 类型），以及编译期类型具象化 `reify` 与 `typecase`。
   Full progression into Dependent Types: type universes, dependent functions ($\Pi$ types), dependent pairs ($\Sigma$ types), Peano naturals and induction, propositional equality (`Eq` / `Refl` / `PathInduction`), and `reify` / `typecase`.

---

### 第四阶段：代数效应、形式化验证与编译期宏（控制流、证明与元编程）
### Stage 4: Algebraic Effects, Formal Verification & Macros (`11` ~ `13`)
探索 TS++ 在副作用解耦、编译期自动定理证明与编译期代码生成方面的进阶能力：
Explore effect handling, automated compile-time theorem proving, and compile-time metaprogramming:
- **[`11-algebraic-effects`](./11-algebraic-effects)** — **代数效应与延续控制**：通过 `effect`、函数 `/ Effect` 子句、`perform` 与 `handle ... in` 将“函数需要什么外部能力”与“能力如何实现”彻底分离；并通过 `suspend` 与 `control`（单次延续 `k.resume` / `k.abort`）在不引入 `async/await` 传染的前提下编写异步与重试控制流。
  Decoupling side effects via `effect`, `/ Effect` clauses, `perform`, and `handle ... in`, plus direct-style suspension with `suspend` and `control` continuations (`k.resume` / `k.abort`).
- **[`12-formal-verification`](./12-formal-verification)** — **编译期形式化验证**：不同于需要手写证明项的依赖类型（`10`），形式化验证让编译器在后台自动将代码转为逻辑公式，对**所有可能的输入**进行静态数学证明。涵盖 `assert:` / `assume:`、`requires:` / `ensures:` 函数契约、循环不变式归纳证明、`with { predicate: ... }` 精化类型、实数与安全整数模型、递归 `data` 验证与类不变式。
  Automated compile-time mathematical verification across all inputs: `assert:` / `assume:`, function `requires:` / `ensures:` contracts, loop and class invariants, refinement types, and arithmetic models.
- **[`13-macros`](./13-macros)** — **编译期宏**：在编译阶段直接检查语法结构、利用 `$()` 模板生成或改写代码，支持异步宏、递归展开以及执行超时预算控制。
  Compile-time AST inspection, code generation with `$()` templates, async and recursive macros, and execution timeout budgets.

---

### 第五阶段：工程集成与 TypeScript 互操作
### Stage 5: Ecosystem & TypeScript Interoperability (`14`)
- **[`14-typescript-interop`](./14-typescript-interop)** — **与标准 TypeScript 互操作**：演示 `.tspp` 与存量 `.ts` 文件的导入规则，以及 TS++ 如何同时生成 `.d.tspp`（供 TS++ 下游使用）与 `.d.ts`（供标准 TypeScript 项目无缝消费）。
  Source boundary rules between `.tspp` and `.ts` files, and dual declaration output (`.d.tspp` and `.d.ts`) for standard TypeScript consumers.

---

## 二、 推荐阅读方法 / Recommended Reading Tips

1. **按编号顺序阅读目录内的 `src/01-xxx.tspp`、`src/02-xxx.tspp`**：
   每个包内部的源码文件均按照“基础概念与写法 $\to$ 组合进阶 $\to$ `@ts-expect-error` 编译期错误边界”的顺序拆分，建议从 `01` 开始依次阅读。
   Read the numbered files inside each package's `src/` folder in order (`01`, `02`, `03`...), which progress from core concepts and syntax to compositions and `@ts-expect-error` compile-time boundary checks.
2. **动手触发编译期报错**：
   许多文件末尾包含带有 `// @ts-expect-error` 注释的反例。在阅读时，你可以尝试删掉某一行 `// @ts-expect-error`，观察编辑器或 `pnpm check` 报出的具体类型/证明错误，能更直观地体会各项静态安全规则。
   Try removing `// @ts-expect-error` comments above negative examples and running `pnpm check` (or hovering in the editor) to see the exact static diagnostics reported by the compiler.

---

## 三、 检查与运行 / Checking & Running

在任意示例子目录中均可执行：

Inside any example package directory, you can run:

```bash
# 运行编译期类型、契约与语法检查 / Run compile-time type, contract, and syntax checks
pnpm check

# 运行代码规范检查 / Run ESLint checks
pnpm lint
```
