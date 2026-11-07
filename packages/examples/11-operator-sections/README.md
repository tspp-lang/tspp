# 11-operator-sections — 运算符与属性切片 / Operator & Member Sections

本目录演示 TS++ 引入的 **`_` 占位符切片表达式（Operator & Member Sections）**。它让你无需编写形如 `x => x + 1`、`item => item.name` 或 `(a, b) => a + b` 的样板箭头函数，直接用 `_` 占位符快速构造类型安全的单参数或双参数简写函数。

This directory demonstrates **`_` placeholder section expressions (Operator & Member Sections)** in TS++. They let you write concise, type-safe unary and binary functions directly with `_` instead of boilerplate arrow functions like `x => x + 1`, `item => item.name`, or `(a, b) => a + b`.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **右切片 / 左切片** | `(_ + 1)` / `(10 - _)` | 将固定了一侧操作数的二元运算转化为单参数函数，严格保留左右操作数顺序（如 `x => x + 1` 与 `x => 10 - x`）。<br/>Turns a partially applied binary operator into a unary function while preserving operand order (`x => x + 1` vs `x => 10 - x`). |
| **双占位符二元切片** | `(_ + _)` / `(_ / _)` | 将两个 `_` 按从左到右的顺序分别绑定为第一个和第二个参数，生成双参数函数 `(left, right) => left / right`。<br/>Binds two `_` placeholders from left to right as `(left, right) => left / right`. |
| **复合算术与比较切片** | `(_ > 0)` / `(_ * 2 + 1)` | 支持比较运算与遵循标准优先级的复合算术表达式（等价于 `x => x * 2 + 1`）。<br/>Supports comparisons and compound arithmetic expressions respecting standard operator precedence (`x => x * 2 + 1`). |
| **属性读取与方法调用切片** | `(_.name)` / `(_.inner.name)` / `(_.trim())` | 将属性访问、链式属性访问或方法调用转化为单参数函数（如 `x => x.trim()`）。<br/>Converts property reads, chained property reads, and method calls into unary functions (`x => x.trim()`). |
| **高阶函数内联切片** | `numbers.filter(_ > 1).map(_ * 10 + 1)` | 直接作为 `.map()`、`.filter()` 等高阶函数的参数使用，自动根据上下文推导出 `_` 的类型。<br/>Used inline as arguments to higher-order methods like `.map()` and `.filter()` with automatic contextual type inference. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-basics.tspp`](./src/01-basics.tspp)** — 演示右切片、左切片、双占位符切片、复合算术与比较切片、属性与方法切片、数组 `.map` / `.filter` 内联用法以及编译期类型检查（`@ts-expect-error`）。
   Demonstrates right sections, left sections, binary sections, compound arithmetic and comparison sections, property/method sections, inline `.map` / `.filter` callbacks, and compile-time error checks (`@ts-expect-error`).

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
