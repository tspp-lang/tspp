# 14-typescript-interop — 与标准 TypeScript 项目的互操作 / Interoperability with Standard TypeScript

本目录演示 TS++ 与标准 TypeScript（`.ts`）在同一项目内及跨包发布时的互操作规则。通过**单向源码边界**与**双声明文件输出（`.d.tspp` + `.d.ts`）**，TS++ 代码既能复用现有的 `.ts` 模块，又能将编译产物无缝发布给只使用原生 `tsc` 的普通 TypeScript 项目消费。

This directory demonstrates how TS++ interoperates with standard TypeScript (`.ts`) both within a single project and across package boundaries. Through a **one-way source boundary** and **dual declaration output (`.d.tspp` + `.d.ts`)**, TS++ code can reuse existing `.ts` modules while publishing compiled packages that ordinary TypeScript projects can consume directly with upstream `tsc`.

---

## 互操作规则概览 / Interoperability Overview

| 互操作机制 / Mechanism | 规则与写法 / Rule & Usage | 引入目的与效果 / Purpose & Effect |
| :--- | :--- | :--- |
| **`.tspp` 导入 `.ts` 源码** | 在 `.tspp` 中 `import { ... } from "./02-legacy.js"` | 允许 `.tspp` 模块直接复用同工程内的标准 `.ts` 类型与函数，支持渐进式迁移。<br/>Allows `.tspp` modules to directly reuse standard `.ts` types and functions in the same project for gradual adoption. |
| **`.ts` 源码边界保护** | 禁止在 `.ts` 中直接 `import ... from "./01-library.tspp"` | 保证 `.ts` 文件始终符合纯正的标准 TypeScript 语法，防止未编译的扩展语法泄漏给标准工具链。<br/>Keeps `.ts` files strictly valid standard TypeScript by preventing uncompiled extended syntax from leaking into `.ts` sources. |
| **原生声明输出（`.d.tspp`）** | `package.json` 配置 `"tsppTypes"` 与 `"tspp-types"` 导出条件 | 为下游 TS++ 消费者完整保留 `newtype`、`data`、契约等一等语言特性。<br/>Preserves first-class TS++ features (`newtype`, `data`, contracts, etc.) for downstream TS++ consumers. |
| **兼容声明输出（`.d.ts`）** | `package.json` 配置标准 `"types"` 导出条件 | 将 TS++ 声明自动投影为标准 TypeScript 兼容的类型与函数签名，使原生 `tsc` 可直接进行类型检查。<br/>Projects TS++ declarations into standard TypeScript types and function signatures so upstream `tsc` can type-check consumers directly. |

---

## 源码文件阅读顺序 / Source Files

1. **[`src/01-library.tspp`](./src/01-library.tspp)** — 导入同目录的标准 `.ts` 模块，并导出 `newtype UserId` 与 `data Lookup<T>`，在构建时同时生成 `.d.tspp` 与 `.d.ts`。
   Imports a sibling `.ts` module and exports `newtype UserId` and `data Lookup<T>`, emitting both `.d.tspp` and `.d.ts` declarations on build.
2. **[`src/02-legacy.ts`](./src/02-legacy.ts)** — 纯标准 TypeScript 编写的接口与工具函数，被 `01-library.tspp` 直接导入。
   Standard TypeScript interface and helper function imported directly by `01-library.tspp`.
3. **[`src/03-source-boundary.ts`](./src/03-source-boundary.ts)** — 演示在标准 `.ts` 源文件中直接通过相对路径导入 `.tspp` 源文件时的编译期拦截（`@ts-expect-error`）。
   Demonstrates compile-time rejection (`@ts-expect-error`) when a standard `.ts` source file attempts to directly import a `.tspp` source file.
4. **[`consumer/src/01-consumer.ts`](./consumer/src/01-consumer.ts)** — 纯标准 TypeScript 消费者项目（使用原生 `tsc` 检查），通过生成的 `.d.ts` 声明无缝使用 `UserId`、`Lookup`、`Found` 与 `Missing`。
   A pure standard TypeScript consumer checked by upstream `tsc`, seamlessly using `UserId`, `Lookup`, `Found`, and `Missing` via the generated `.d.ts` declarations.

---

## 检查与代码规范 / Check & Lint

```bash
pnpm check
pnpm lint
```
