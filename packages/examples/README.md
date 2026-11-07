# TS++ 示例与教程 / TS++ Examples & Tutorials

本目录汇集了 TS++ 语言核心特性的分步示例工程。每个编号子目录都是一个独立的包，源码统一位于各自目录的 `src/` 下，并配有完整的中英双语概念说明与代码示例。

This directory contains step-by-step example projects covering the core language features of TS++. Each numbered subdirectory is an independent package with bilingual explanations and source files under `src/`.

---

## 教程目录与学习路线 / Learning Path

| 目录 / Directory | 核心语言特性 / Core Language Capabilities |
| :--- | :--- |
| **[`01-modern-syntax`](./01-modern-syntax)** | `let ... in` 局部表达式绑定、`do { ... }` 求值块、`do` 函数体、`use <-` 尾闭包绑定与 `def` 深度只读声明。<br/>Value-level `let ... in`, `do { ... }` completion blocks, `do` function bodies, `use <-` trailing closures, and `def` deep-readonly bindings. |
| **[`02-formal-verification`](./02-formal-verification)** | 编译期形式化验证：证明点（`assert:` / `assume:`）、函数契约（`requires` / `ensures`）、循环与类不变式（`invariant:`）及精化类型。<br/>Compile-time formal verification: proof points (`assert:` / `assume:`), function contracts (`requires` / `ensures`), loop/class invariants, and refinement types. |
| **[`03-nominal-types`](./03-nominal-types)** | `newtype` 名义包装类型、`data` 代数数据类型（和类型）以及带穷尽性检查与守卫的 `match` 模式匹配。<br/>`newtype` nominal wrappers, algebraic `data` declarations, and exhaustive `match` pattern matching with guards. |
| **[`04-newtype-consumer`](./04-newtype-consumer)** | 跨包导入并消费 `03-nominal-types` 导出的名义类型与代数数据类型，保持编译期名义区分度。<br/>Consuming nominal `newtype` and `data` declarations across package boundaries while preserving nominal identity. |
| **[`05-dependent-types`](./05-dependent-types)** | 依赖类型系统：类型宇宙层级（`Type0` / `Type1`）、依赖函数（$\Pi$ 类型）、依赖对（$\Sigma$ 类型）、皮亚诺自然数、相等性证明（`Eq` / `Refl`）与 `reify` / `typecase`。<br/>Dependent types: type universes, dependent functions ($\Pi$ types), dependent pairs ($\Sigma$ types), Peano naturals, propositional equality (`Eq` / `Refl`), and `reify` / `typecase`. |
| **[`06-type-computation`](./06-type-computation)** | 结构化类型级计算：类型级 `let ... in` 局部绑定、有序 `match` 类型模式匹配与 `<T> =>> ...` 匿名类型函数。<br/>Structured type-level computation: type-level `let ... in` bindings, ordered `match` type pattern matching, and `<T> =>> ...` type lambdas. |
| **[`07-higher-kinded-types`](./07-higher-kinded-types)** | 高阶类型（HKT）：Kind 标注（`Type => Type`）、将未实例化的泛型构造器（如 `Array`）作为参数传递，以及高阶容器抽象。<br/>Higher-Kinded Types: kind annotations (`Type => Type`), first-class generic type constructors, and higher-kinded container abstractions. |
| **[`08-static-interface-members`](./08-static-interface-members)** | 在 `interface` 中同时声明 `static` 静态成员契约与实例成员契约，约束类的静态属性与静态工厂方法。<br/>Declaring `static` member contracts alongside instance members in interfaces. |
| **[`09-typescript-interop`](./09-typescript-interop)** | TS++ 源码（`.tspp`）与标准 TypeScript 源码（`.ts`）的互操作边界与声明文件消费。<br/>Interoperability between `.tspp` and standard `.ts` files across module and package boundaries. |
| **[`10-macros`](./10-macros)** | 编译期宏：语法检查宏、使用 `$()` 模板的代码转换宏、异步宏、递归宏以及超时预算控制。<br/>Compile-time macros: validation macros, code generation with `$()` templates, async macros, recursive macros, and timeout budgets. |
| **[`11-operator-sections`](./11-operator-sections)** | 使用 `_` 占位符的运算符与成员切片简写表达式，如 `(_ + 1)`、`(10 - _)`、`(_ / _)`、`(_.name)`。<br/>Placeholder-based operator and member sections using `_`, such as `(_ + 1)`, `(10 - _)`, `(_ / _)`, and `(_.name)`. |
| **[`12-advanced-classes`](./12-advanced-classes)** | 现代类特性：`field` 隐式存储属性、`object` 单例、`data class`、`with` 非破坏性拷贝、`sealed class` 封闭继承层次与 `final` 修饰符。<br/>Advanced class features: `field` properties, `object` singletons, `data class`, `with` copy expressions, `sealed class` hierarchies, and `final` modifiers. |
| **[`13-typeclasses`](./13-typeclasses)** | 类型类（`typeclass`）、实现声明（`impl`）、`where` 上下文约束、`@{ ... }` 显式实现传入以及类的扩展方法。<br/>Typeclasses (`typeclass`), implementations (`impl`), `where` constraints, explicit `@{ ... }` context arguments, and inherent extension methods. |
| **[`14-algebraic-effects`](./14-algebraic-effects)** | 代数效应：`effect` 声明、函数效应子句（`/ Effect`）、`perform` 调用、`handle ... in` 处理器以及 `suspend` / `control` 延续恢复与中断。<br/>Algebraic effects: `effect` declarations, function effect clauses (`/ Effect`), `perform`, `handle ... in` handlers, and `suspend` / `control` continuations. |

---

## 检查与运行 / Checking & Running

在任意示例子目录中均可执行：

Inside any example package directory, you can run:

```bash
# 运行类型与语法检查 / Run compile-time type and syntax checks
pnpm check

# 运行代码规范检查 / Run ESLint checks
pnpm lint
```
