# 11-algebraic-effects — 代数效应与可挂起续延 / Algebraic Effects & Suspending Continuations

本目录演示 TS++ 的**代数效应（Algebraic Effects）**系统。代数效应将“函数需要什么外部能力（`effect` / `perform`）”与“外部如何实现这些能力（`handle ... in`）”解耦，并通过可挂起操作（`suspend` / `control`）让你用无需 `async / await` 染色的直接风格编写异步与控制流代码。

This directory demonstrates **Algebraic Effects** in TS++. Algebraic effects decouple *what* external capabilities a function performs (`effect` / `perform`) from *how* those capabilities are handled (`handle ... in`), and let you write asynchronous workflows in direct style without `async / await` coloring via suspending operations (`suspend` / `control`).

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`effect` 效应声明** | `effect State<S> { get(): S; set(v: S): void; }` | 声明一组抽象的上下文操作契约，支持泛型类型参数。<br/>Declares an abstract contract of contextual operations, with full support for generic type parameters. |
| **`/ Effect` 函数效应标注** | `function compute(x: number) / { Logger, Reader }: number` | 在函数签名上显式列出该函数所需的效应，由类型系统在编译期追踪。<br/>Lists the effects required by a function right in its signature, tracked statically at compile time. |
| **`perform` 触发操作** | `const factor = perform Reader.ask("factor");` | 在函数体内触发指定的效应操作，具体行为由外围的 `handle` 块决定。<br/>Invokes an effect operation whose concrete behavior is supplied by an enclosing `handle` block. |
| **`handle ... in` 效应处理器** | `handle State<number> { get: () => s, set: v => ... } in { ... }` | 为代码块提供效应的具体实现，支持链式嵌套、`return` 结果转换以及内层拦截转发。<br/>Provides concrete implementations for an effect around a block, supporting chaining, `return` mapping, and shadowing. |
| **`suspend` 与 `control` 续延** | `control wait(ms, k) { setTimeout(() => k.resume(), ms); }` | 将操作声明为可挂起，在处理器中通过单次续延 `k.resume()` 恢复执行或 `k.abort()` 抛出异常，无需 `async/await`。<br/>Allows operations to suspend and resume via one-shot continuation `k.resume()` or `k.abort()` without `async/await`. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/11-algebraic-effects.tspp`](./src/11-algebraic-effects.tspp)** — `effect` 声明、函数签名 `/ Effect` 标注、`perform` 调用、`handle ... in` 链式处理、`return` 子句、泛型 `State<S>` 以及内层处理器拦截。
   Covers `effect` declarations, `/ Effect` annotations, `perform` calls, chained `handle ... in` blocks, `return` clauses, generic `State<S>`, and handler shadowing.
2. **[`src/02-suspension.tspp`](./src/02-suspension.tspp)** — `suspend` 可挂起效应与 `control` 续延处理器，演示用直接风格编写异步代码（`k.resume`）与异常注入恢复（`k.abort` + `try / catch`）。
   Covers `suspend` operations and `control` handlers, demonstrating direct-style asynchronous execution (`k.resume`) and error injection/recovery (`k.abort` + `try / catch`).

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
