# 03-nominal-types — 名义类型与代数数据类型 / Nominal Types & Algebraic Data Types

本目录演示 TS++ 引入的**名义包装类型（`newtype`）**、**代数数据类型（`data`）**与**模式匹配表达式（`match`）**。它们解决了标准 TypeScript 结构化类型系统中“底层结构相同即可混用”的安全隐患，并提供紧凑、具有编译期穷尽性检查的分支建模能力。

This directory demonstrates **nominal wrapper types (`newtype`)**, **algebraic data types (`data`)**, and **pattern matching expressions (`match`)** in TS++. Together they prevent accidental mixing of structurally identical types and provide concise sum-type modeling with compile-time exhaustiveness checking.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`newtype` 名义包装类型** | `newtype UserId = string;` | 创建名字独立的名义类型：两个不同 `newtype` 互不兼容，必须通过 `UserId("...")` 显式构造，但可直接当作底层类型 `string` 使用（单向兼容）。<br/>Creates a distinct nominal type that rejects accidental mixing with other `newtype`s or raw values while remaining assignable back to its underlying type. |
| **`data` 代数数据类型** | `data Option<T> = None \| Some(value: T);` | 一行代码声明封闭的多分支数据类型（和类型），自动提供零参构造器（`None`）与带参构造器（`Some(value)`）。<br/>Declares closed sum types in a single line, automatically providing nullary and positional-field constructors. |
| **`match` 模式匹配** | `match opt { None => 0, Some(v) => v }` | 面向表达式的分支匹配，支持字段解构、多层嵌套拆包、无参或模式（`\|`）、守卫条件（`if`）与通配符（`_`），并在编译期强制检查分支穷尽性。<br/>Expression-oriented pattern matching with field destructuring, nested patterns, `\|` or-patterns, `if` guards, wildcards `_`, and compile-time exhaustiveness checking. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-basics.tspp`](./src/01-basics.tspp)** — `newtype` 名义包装与单向兼容性、`data` 代数数据类型定义、`match` 模式匹配（解构、守卫、或模式、嵌套匹配、递归链表）以及编译期错误拦截（`@ts-expect-error`）。
   Covers `newtype` nominal wrappers and one-way assignability, `data` sum types, `match` expressions (destructuring, guards, or-patterns, nested patterns, recursive lists), and compile-time error checks (`@ts-expect-error`).
2. **[`src/02-composed-patterns.tspp`](./src/02-composed-patterns.tspp)** — 多泛型参数和类型 `Either<Left, Right>`、多层嵌套 `data` 模式匹配与对象 `newtype` 的 `keyof` 属性保留。
   Covers multi-parameter `Either<Left, Right>`, deeply nested `data` matching with guards, and `keyof` preservation on object `newtype`s.
3. **[`src/03-regressions.tspp`](./src/03-regressions.tspp)** — 泛型构造器字段直接访问、在 `match` 分支内嵌套 `match` 表达式，以及用 `_` 忽略不需要的构造器位置字段。
   Covers direct field access on generic constructors, nested `match` expressions, and ignoring positional fields with `_`.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
