# 13-macros — 编译期宏 / Compile-Time Macros

本目录演示 TS++ 的**编译期宏（Compile-Time Macros）**系统。宏是在编译阶段运行的函数：它可以检查目标声明的语法结构、在编译期报出自定义错误，或者在编译期生成新的类型与变量声明（生成的代码直接参与同文件的静态类型检查，且宏定义本身在运行时零开销擦除）。

This directory demonstrates **Compile-Time Macros** in TS++. Macros are functions that execute during compilation: they can inspect the AST structure of target declarations, report custom compile-time diagnostics, or synthesize new declarations that immediately participate in static type checking with zero runtime overhead for the macro definition itself.

---

## 特性概览 / Feature Overview

| 语法特性 / Feature | 写法示例 / Syntax Example | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`macro function` 定义** | `export macro function check([target], ctx) { ... }` | 定义在编译期接收目标语法树（`MacroTarget`）与上下文（`MacroContext`）的宏函数。<br/>Defines a compile-time macro function that receives target AST metadata (`MacroTarget`) and `MacroContext`. |
| **`macro <调用>` 展开** | `macro exposeTypeName(Box);` | 在编译期对指定目标触发宏检查或代码生成，展开后的声明在同一文件后续代码中立即可用。<br/>Triggers compile-time validation or code generation on targets; emitted statements are immediately visible to subsequent code. |
| **`async macro` 异步宏** | `export async macro(...) function exposeLater(...)` | 允许在编译期宏内部使用 `await` 等待异步计算完成后再生成语法树节点。<br/>Allows `await` inside a compile-time macro before returning synthesized AST statements. |
| **递归宏展开** | `context.factory.createMacroInvocationStatement(...)` | 支持在宏中返回另一条 `macro` 调用语句，由编译器自动继续递归展开直至全部变为普通代码。<br/>Allows a macro to emit another `macro` invocation statement, which the compiler recursively expands to completion. |
| **`macro({ timeout })` 预算控制** | `macro({ timeout: { type: "fixed", value: 2, unit: "s" } })` | 为编译期宏设置最大执行时长预算，防止死循环或慢速宏阻塞编译器与编辑器。<br/>Configures an execution timeout budget so slow or runaway macros cannot stall the compiler or editor. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-check.tspp`](./src/01-check.tspp)** — 定义并调用编译期静态检查宏 `requireFunction`，验证目标声明是否为函数声明。
   Defines and invokes a compile-time validation macro `requireFunction` that checks whether a target declaration is a function.
2. **[`src/02-transform.tspp`](./src/02-transform.tspp)** — 使用宏在编译期构造新的 `export const` 声明语句，并在同一文件中立即享受精确的字面量类型推导。
   Synthesizes an `export const` declaration at compile time and immediately uses it with exact literal type inference.
3. **[`src/03-async.tspp`](./src/03-async.tspp)** — 定义并调用异步编译期宏 `exposeLater`，演示编译期异步求值与代码生成。
   Defines and invokes an asynchronous compile-time macro `exposeLater`.
4. **[`src/04-recursive.tspp`](./src/04-recursive.tspp)** — 演示多阶段递归宏展开：宏 `begin` 生成对宏 `finish` 的调用，再由 `finish` 生成最终常量。
   Demonstrates multi-stage recursive macro expansion where `begin` emits a `macro finish(...)` invocation.
5. **[`src/05-security.tspp`](./src/05-security.tspp)** — 演示宏的执行超时预算配置（`timeout`）以及无参编译期常量内联。
   Demonstrates macro execution timeout configuration (`timeout`) and zero-argument compile-time constant inlining.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
