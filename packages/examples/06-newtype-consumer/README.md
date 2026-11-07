# 06-newtype-consumer — 跨包消费名义类型与代数类型 / Cross-Package Nominal Types & ADTs

本目录演示如何在下游包中导入并使用上游包（[`05-nominal-types`](../05-nominal-types)）导出的 **`newtype` 名义包装类型**与 **`data` 代数数据类型**。跨越包边界后，名义隔离性、构造器参数约束以及 `match` 模式匹配的穷尽性检查均完整保持。

This directory demonstrates how a downstream package imports and uses **`newtype` nominal wrappers** and **`data` algebraic data types** exported by an upstream package ([`05-nominal-types`](../05-nominal-types)). Across package boundaries, nominal isolation, constructor arity rules, and `match` exhaustiveness checking are fully preserved.

---

## 特性概览 / Feature Overview

| 跨包能力 / Cross-Package Capability | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **跨包 `newtype` 构造与隔离** | `const id: UserId = UserId("u-1");` | 从外部包导入 `newtype` 后，依然必须通过构造器显式包装，且不同 `newtype`（如 `UserId` 与 `OrderId`）之间禁止混用。<br/>Imported `newtype`s still require explicit construction and reject mixing distinct nominal types across packages. |
| **跨包 `data` 与 `match` 匹配** | `match OptionBox(opt) { OptionBox(Some(v)) => v, ... }` | 从外部包导入的 `data` 类型及其构造器可直接参与单层或嵌套 `match` 模式匹配、守卫条件与穷尽性检查。<br/>Imported `data` types and constructors support single-level and nested `match` patterns, guards, and exhaustiveness checks. |
| **`newtype` 构造器调用约束** | `UserId("u-1")`（仅限单参直接调用） | 编译期强制要求 `newtype` 构造器必须传入恰好 1 个参数直接调用，防止无参调用、多参调用或将其作为一等函数值泄漏。<br/>Statically enforces that `newtype` constructors are called directly with exactly one argument and cannot escape as first-class values. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-consumer.tspp`](./src/01-consumer.tspp)** — 从 `@tspp/example-nominal-types` 导入 `UserId`、`OrderId`、`Option`、`Status` 与 `OptionBox`，演示跨包构造、嵌套 `match` 模式匹配以及编译期错误拦截（`@ts-expect-error`）。
   Imports `UserId`, `OrderId`, `Option`, `Status`, and `OptionBox` from `@tspp/example-nominal-types` to demonstrate cross-package construction, nested `match` expressions, and compile-time error checks (`@ts-expect-error`).

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
