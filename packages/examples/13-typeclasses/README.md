# 13-typeclasses — 类型类与隐式上下文 / Typeclasses & Implicit Contexts

本目录演示 TS++ 的**类型类（Typeclasses）**与**固有方法扩展（Inherent Implementations）**。不同于传统面向对象中必须在定义类时耦合实现的 `interface`，类型类将“数据类型定义”与“能力实现”解耦：你可以随时为基础类型（如 `number`）或已有类注册能力、支持泛型容器的自动条件推导（如 `Box<T>`）、并在调用处按需切换不同实现。

This directory demonstrates **Typeclasses** and **Inherent Implementations** in TS++. Unlike traditional OOP `interface` declarations that must be implemented inside a class definition, typeclasses decouple data types from capability implementations: you can retroactively implement capabilities for primitive types (like `number`) or existing classes, derive generic implementations conditionally (like `Box<T>`), and override implementations at specific call sites.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`typeclass` 声明** | `typeclass Eq<A, B = A> { equals(a: A, b: B): boolean; }` | 定义独立于具体类层次的能力契约，可关联一个或多个类型参数。<br/>Defines a capability contract independent of class hierarchies, relating one or more type parameters. |
| **`impl` 类型类实现** | `impl NumberEq = Eq<number> { equals(a, b) { return a === b; } }` | 在类型定义外部为任意类型（包括基础类型）注册类型类的默认实现。<br/>Registers a default typeclass implementation for any type (including primitives) outside its definition. |
| **`where <...>` 上下文约束** | `function equal<A>(a: A, b: A) where <Eq<A>>: boolean` | 在函数或类签名上声明所需的类型类能力或类型级谓词，调用时自动在作用域内检索对应实现。<br/>Declares required typeclass capabilities or type predicates on functions or classes, resolved automatically at call sites. |
| **`@{ ... }` 显式上下文覆盖** | `equal(@{ CloseEq }, 1, 1.25)` | 在调用处显式指定本次调用使用的类型类实现，覆盖默认的自动检索结果。<br/>Explicitly supplies a specific typeclass implementation at a call site, overriding automatic resolution. |
| **泛型条件实现** | `impl<T> BoxEq = Eq<Box<T>> where <Eq<T>> { ... }` | 当元素类型 `T` 满足前置约束时，自动为泛型容器 `Box<T>` 合成对应的类型类实现。<br/>Automatically synthesizes a typeclass implementation for `Box<T>` whenever element type `T` satisfies the constraint. |
| **`impl Class` 固有方法扩展** | `impl Box<number> { doubled(self): number { ... } }` | 在不修改原类的前提下，为泛型类或特定类型特化版本直接扩展成员方法。<br/>Adds instance methods to a generic class or a specific type specialization without modifying the class declaration. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-typeclasses.tspp`](./src/01-typeclasses.tspp)** — `typeclass` 声明、`impl` 实现、`where` 函数约束、`@{ ... }` 显式实现切换，以及编译期类型谓词约束。
   Covers `typeclass` declarations, `impl` definitions, `where` function constraints, `@{ ... }` explicit context overrides, and type predicate constraints.
2. **[`src/02-generic-and-inherent.tspp`](./src/02-generic-and-inherent.tspp)** — 泛型容器的条件实现推导（`BoxEq`）、带 `where` 约束的类，以及 `impl<T> Box<T>` 与 `impl Box<number>` 固有方法扩展。
   Covers conditional generic implementations (`BoxEq`), constrained classes, and inherent extension methods on `Box<T>` and `Box<number>`.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
