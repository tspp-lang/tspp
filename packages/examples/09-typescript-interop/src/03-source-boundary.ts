// ============================================================================
// 09-typescript-interop / 03-source-boundary.ts
//
// 源码边界规则：为什么标准 `.ts` 文件不能直接导入 `.tspp` 源文件？
//
// 在同一个编译工程内，源码级的导入方向是严格单向的（`.tspp` 可以导入 `.ts`，但 `.ts` 不能直接导入 `.tspp` 源文件）：
//   - `.ts` 文件代表“纯标准 TypeScript 代码”，必须保证在不依赖 TS++ 语法扩展的前提下也能被标准工具链理解；
//   - 如果允许 `.ts` 源文件直接通过相对路径导入未编译的 `.tspp` 源文件，标准 TypeScript 工具将无法解析其中的扩展语法。
//
// 当标准 `.ts` 代码需要使用 `.tspp` 导出的功能时，应当通过构建后的包入口（读取生成的 `.d.ts` 兼容声明）来消费，
// 详见 `consumer/src/01-consumer.ts`。
// ============================================================================
// Source Boundary Rule: Why Can't Standard `.ts` Files Directly Import `.tspp` Source Files?
//
// Within a single project, source-level imports are strictly one-way (`.tspp` can import `.ts`, but `.ts` cannot
// directly import `.tspp` source files):
//   - `.ts` files represent pure standard TypeScript and must remain understandable by standard tooling;
//   - Allowing `.ts` source files to directly import uncompiled `.tspp` sources via relative paths would expose
//     extended syntax to standard TypeScript tools that cannot parse it.
//
// When standard `.ts` code needs functionality written in `.tspp`, it should consume the built package entry
// (backed by the generated `.d.ts` compatibility declarations), as shown in `consumer/src/01-consumer.ts`.
// ============================================================================

// 尝试在 `.ts` 源文件中直接导入 `.tspp` 实现文件会在编译期报错拦截
// Attempting to directly import a `.tspp` implementation file from a `.ts` source file is rejected at compile time
// @ts-expect-error Ordinary TypeScript sources cannot import TS++ implementation files.
import type { UserId } from "./01-library.tspp";

export type ForbiddenSourceImport = UserId;
