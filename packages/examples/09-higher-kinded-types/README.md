# 09-higher-kinded-types — 高阶类型与 Kind 系统 / Higher-Kinded Types & Kinds

本目录循序渐进地介绍 TS++ 的 **Kind（类型的分类）** 与 **高阶类型（Higher-Kinded Types，简称 HKT）**。
在标准 TypeScript 中，你只能把已经填好参数的完整类型（如 `Array<number>`）作为泛型参数传递，却无法把未传参的泛型构造器本身（如 `Array`）作为参数传递，因而无法写出对所有容器通用的 `Functor<Container>` 接口。TS++ 通过引入显式的 Kind 标注（如 `Type => Type`、`(Type, Type) => Type`），让类型构造器成为可传递、可返回、可组合的一等公民。

This directory introduces **Kinds (the types of types)** and **Higher-Kinded Types (HKT)** in TS++.
In standard TypeScript, only fully applied types (such as `Array<number>`) can be passed as type arguments, while unapplied type constructors (such as bare `Array`) cannot — making it impossible to express unified container abstractions like `Functor<Container>`. TS++ introduces explicit Kind annotations (`Type => Type`, `(Type, Type) => Type`) so type constructors can be passed, returned, and composed as first-class citizens.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **0 阶值类型与类型宇宙 / Proper Types & Universes** | `type N: Type0 = number;`<br/>`type U0: Type1 = Type0;` | 将普通值类型归入 `Type0`，并将宇宙本身按 `Type0 : Type1 : Type2` 严格分层。<br/>Classifies ordinary value types under `Type0` and stratifies universes into `Type0 : Type1 : Type2`. |
| **一元类型构造器 / Unary Type Constructors** | `export type Arrays: Type => Type = Array;` | 描述“接收 1 个类型参数并产出 1 个新类型”的泛型构造器，允许将未传参的 `Array` 保存或传递。<br/>Describes a unary constructor taking 1 type and producing 1 type, allowing unapplied `Array` to be bound and passed. |
| **二元类型构造器 / Binary Type Constructors** | `type Apply2<C: (Type, Type) => Type, L, R> = C<L, R>;` | 描述“接收 2 个类型参数并产出 1 个新类型”的二元泛型构造器（如 `Pair`）。<br/>Describes a binary constructor taking 2 types and producing 1 type (such as `Pair`). |
| **高阶容器接口 / Higher-Kinded Interfaces** | `interface Functor<Container: Type => Type> { ... }` | 用同一个接口统一约束 `Array`、`Box` 等任意一元泛型容器的映射能力。<br/>Abstracts uniformly over any unary container (`Array`, `Box`, etc.) with a single interface. |
| **构造器返回与链式调用 / Returning & Chaining Constructors** | `IdentityConstructor<Array><number>` | 允许高阶类型返回 `Type => Type` 构造器，并直接通过连续尖括号应用下一层类型参数。<br/>Allows higher-kinded aliases to return `Type => Type` constructors and chain `<...><...>` applications directly. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-basics.tspp`](./src/01-basics.tspp)** — 什么是 Kind 与高阶类型、类型宇宙层级（`Type0 : Type1 : Type2`）、一元/二元构造器标注（`Type => Type`、`(Type, Type) => Type`）以及 `Functor<Container: Type => Type>` 接口。
   Introduces Kinds, universe levels (`Type0 : Type1 : Type2`), unary/binary constructor kinds, and the `Functor<Container: Type => Type>` interface.
2. **[`src/02-constructor-composition.tspp`](./src/02-constructor-composition.tspp)** — 返回类型构造器的高阶类型、`<Array><number>` 连续尖括号调用、在同一类型中多次实例化同一构造器 `Mapping<Container, Input, Output>` 以及多容器 `Functor` 实现。
   Covers higher-kinded aliases returning constructors, chained `<Array><number>` application, multi-type instantiation `Mapping<Container, Input, Output>`, and `Box` functor implementation.
3. **[`src/03-kind-boundaries.tspp`](./src/03-kind-boundaries.tspp)** — 构造器参数个数不匹配、把值类型当构造器、跨宇宙层级混用以及省略泛型参数时的编译期安全拦截（`@ts-expect-error`）。
   Covers compile-time kind and universe safety checks (`@ts-expect-error`) for arity mismatches, value-vs-constructor misuse, and non-cumulative universes.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
