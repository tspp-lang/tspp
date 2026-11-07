// ============================================================================
// 14-typescript-interop / consumer/src/01-consumer.ts
//
// 标准 TypeScript 下游项目消费 TS++ 编译产物
//
// 本文件由原生 TypeScript 编译器（`tsc`）直接进行类型检查，完全不启用 TS++ 编译器。
// 当从 `@tspp/example-typescript-interop` 导入时：
//   - 原生 `tsc` 会自动根据 `package.json` 中的 `"types"` 字段读取 `dist/01-library.d.ts`；
//   - 如果下游是 TS++ 项目，则会根据 `"tspp-types"` 导出条件优先读取 `dist/01-library.d.tspp`。
// ============================================================================
// Consuming Compiled TS++ Output from a Standard TypeScript Project
//
// This file is type-checked directly by the upstream TypeScript compiler (`tsc`) without the TS++ compiler.
// When importing from `@tspp/example-typescript-interop`:
//   - Upstream `tsc` resolves `dist/01-library.d.ts` via the `"types"` field in `package.json`;
//   - A downstream TS++ project would instead resolve `dist/01-library.d.tspp` via the `"tspp-types"` export condition.
// ============================================================================

// 从构建好的包入口导入由 TS++ 编写并投影到 `.d.ts` 的类型与构造器函数
// Import types and constructor functions authored in TS++ and projected into `.d.ts` from the built package entry
import {
  Found,
  Missing,
  UserId,
  loadUser,
  type Lookup,
} from "@tspp/example-typescript-interop";

// 在纯 TypeScript 中调用 `newtype` 构造器创建 `UserId`
// Call the `newtype` constructor in plain TypeScript to create a `UserId`
const id: UserId = UserId("user-1");

// 在纯 TypeScript 中使用 `data` 的构造器 `Found` 与单例分支 `Missing`
// Use the `data` constructor `Found` and singleton variant `Missing` in plain TypeScript
const found: Lookup<number> = Found(42);
const missing: Lookup<number> = Missing;

// 调用导出的普通函数，返回 `Lookup<LegacyUser>`
// Call the exported function returning `Lookup<LegacyUser>`
const loaded = loadUser({ id, displayName: " Ada " });

console.log("[14-typescript-interop/consumer]", { found, missing, loaded });
