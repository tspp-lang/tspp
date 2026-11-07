# 06-type-computation — 结构化类型级计算 / Structured Type-Level Computation

本目录演示 TS++ 在**类型层面（Type Level）**引入的三项核心计算语法。
在标准 TypeScript 中，一旦类型体操稍微复杂，就只能靠污染全局作用域的辅助 `type` 别名、层层缩进的 `T extends ... ? ... : ...` 条件三元金字塔，而且泛型类型不能像函数一样作为参数传递。TS++ 让类型级编程拥有了与值级函数式编程完全一致的清晰结构。

This directory demonstrates three core **type-level computation** features in TS++.
In standard TypeScript, complex type transformations quickly degenerate into file-level helper `type` aliases, deeply nested `T extends ... ? ... : ...` ternary pyramids, and second-class generics that cannot be passed as arguments. TS++ brings clean functional programming constructs directly to the type level.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **类型级 `let ... in` 局部绑定** | `let Payload = { data: T } in [Payload, Payload]` | 在类型表达式内部声明局部中间类型别名，支持链式推导与同名遮蔽，不会泄漏到外部作用域。<br/>Binds local intermediate type aliases inside a type expression with chaining and shadowing, without polluting outer scopes. |
| **类型级 `match` 模式匹配** | `match T { [infer H, ...infer R]: H, _: T }` | 按从上到下的顺序对字面量、元组、数组、对象结构进行模式匹配与 `infer` 解构，彻底替代多层嵌套的条件三元类型。<br/>Matches literals, tuples, arrays, and objects top-to-bottom with `infer` extraction, replacing nested conditional ternaries. |
| **匿名类型函数 (`<T> =>> ...`)** | `type Box = <Value> =>> { value: Value };` | 将类型转换定义为可赋值给别名、可柯里化（Currying）、可作为高阶参数传递（`Constructor: Type => Type`）的一等公民。<br/>Defines first-class anonymous type functions that support currying, constraints, and higher-order application (`Type => Type`). |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-let-bindings.tspp`](./src/01-let-bindings.tspp)** — 类型级 `let ... in ...` 局部绑定、链式流水线推导、词法同名遮蔽与作用域边界检查（`@ts-expect-error`）。
   Covers type-level `let ... in ...` bindings, chained pipelines, lexical shadowing, and scope isolation checks (`@ts-expect-error`).
2. **[`src/02-type-match.tspp`](./src/02-type-match.tspp)** — 类型级 `match T { ... }` 有序结构匹配，演示字面量、元组首尾 `[infer Head, ...infer Tail]`、数组、对象属性解构与 `_` 兜底分支。
   Covers ordered `match T { ... }` across literals, tuple head/rest patterns, arrays, object properties, and `_` fallbacks.
3. **[`src/03-type-lambdas.tspp`](./src/03-type-lambdas.tspp)** — 匿名类型函数 `<T> =>> ...`、类型级柯里化与部分应用、高阶 `Apply` / `Compose` 以及参数个数与 Kind 边界检查（`@ts-expect-error`）。
   Covers anonymous type lambdas `<T> =>> ...`, currying, higher-order `Apply` / `Compose`, and arity/kind checks (`@ts-expect-error`).
4. **[`src/04-combined-computation.tspp`](./src/04-combined-computation.tspp)** — 综合运用 `match`、`let ... in` 与 `<T> =>>` 编写通用容器转换器 `Transform<Container, Mapper>`。
   Combines `match`, `let ... in`, and `<T> =>>` to build a reusable structural mapper `Transform<Container, Mapper>`.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
