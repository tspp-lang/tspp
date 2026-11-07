# 01-modern-syntax — 现代函数式语法 / Modern Functional Syntax

本目录演示 TS++ 在值层面引入的四项现代语法特性。它们让代码可以直接围绕**表达式求值**与**不可变数据**来编写，消除冗余的中间可变变量与多层回调缩进。

This directory demonstrates four value-level syntax features in TS++. They let you write code directly around **expression evaluation** and **immutable data**, eliminating temporary mutable variables and deeply nested callbacks.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`let ... in` 局部绑定** | `let a = 20, b = 22 in a + b` | 在表达式内部声明临时局部变量并直接算出结果，变量不会泄漏到外部作用域。<br/>Declares local variables inside an expression to compute a result without leaking names outward. |
| **`do { ... }` 求值块** | `const x = do { const a = 1; a + 2; };` | 将多条语句或 `if / else` 分支组合成一个表达式，自动以最后执行的表达式作为整个块的值。<br/>Groups statements or `if / else` branches into a single expression yielding its final evaluated value. |
| **`do` 函数与方法体** | `function add(a: number, b: number) do { a + b; }` | 让函数体直接作为求值块运行，无需手写 `return` 即可返回末尾表达式。<br/>Treats a function or method body as a completion block that implicitly returns its final expression. |
| **`use <-` 尾闭包绑定** | `do { use x <- withValue(40); x + 2; }` | 将 `do` 块剩余语句自动作为回调函数传给右侧函数，把多层嵌套的回调金字塔拉平为线性代码。<br/>Passes the rest of a `do` block as a trailing callback, flattening nested callback pyramids into linear code. |
| **`def` 深度只读声明** | `def data = { inner: { value: 1 }, items: [10, 20] };` | 声明深度不可变（Deep Readonly）的值绑定，禁止修改任意层级的嵌套属性或数组元素，并保留精确字面量类型。<br/>Declares deeply readonly bindings that forbid nested mutations and preserve exact literal types. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-basics.tspp`](./src/01-basics.tspp)** — `let ... in` 局部表达式绑定、`do { ... }` 求值块以及 `do` 函数与方法体。
   Covers `let ... in` local expression bindings, `do { ... }` completion blocks, and `do` function/method bodies.
2. **[`src/02-use-continuations.tspp`](./src/02-use-continuations.tspp)** — `use <-` 尾闭包绑定的基本写法、多层平铺链式调用，以及对后续代码执行顺序与提前返回的控制。
   Covers `use <-` trailing-closure bindings, flat multi-step chaining, and controlling execution of the remaining block.
3. **[`src/03-def-and-boundaries.tspp`](./src/03-def-and-boundaries.tspp)** — `def` 深度只读声明的效果验证，以及违反各语法规则时的编译期报错示例（`@ts-expect-error`）。
   Covers `def` deep-readonly declarations and compile-time error checks (`@ts-expect-error`).

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
