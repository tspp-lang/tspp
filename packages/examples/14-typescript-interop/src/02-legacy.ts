// ============================================================================
// 14-typescript-interop / 02-legacy.ts
//
// 被 `.tspp` 模块导入的标准 TypeScript 源文件（`.ts`）
//
// 这是一个普通的 `.ts` 文件，只使用标准 TypeScript 语法。
// 它可以被同项目中的 `.tspp` 模块无缝导入，而无需将已有的 `.ts` 代码全部改名为 `.tspp`。
// ============================================================================
// Standard TypeScript Source File Imported by `.tspp` (`.ts`)
//
// This is an ordinary `.ts` file using only standard TypeScript syntax.
// It can be imported seamlessly by `.tspp` modules in the same project without renaming existing `.ts` files.
// ============================================================================

// 标准 TypeScript 接口定义，可直接被 `.tspp` 文件导入使用
// Standard TypeScript interface definition that can be imported directly by `.tspp` files
export interface LegacyUser {
  readonly id: string;
  readonly displayName: string;
}

// 标准 TypeScript 函数，去除字符串首尾空白
// Standard TypeScript function that trims leading and trailing whitespace
export function normalizeName(name: string): string {
  return name.trim();
}
