/// <reference types="vite/client" />

declare module "virtual:tspp-libs" {
  /** Lib file contents keyed by built file name, e.g. `lib.es2022.d.ts`. */
  const libs: Readonly<Record<string, string>>;
  export default libs;
}

declare module "virtual:tspp-examples" {
  interface ExampleProject {
    /** The packages/examples directory name, e.g. `02-dependent-types`. */
    readonly id: string;
    readonly features: readonly string[];
    /** The file opened first. */
    readonly entry: string;
    /** File contents keyed by project-relative absolute path, e.g. `/src/01-basics.tspp`. */
    readonly files: Readonly<Record<string, string>>;
  }
  const examples: readonly ExampleProject[];
  export default examples;
}

declare module "virtual:tspp-package-types" {
  /** Declaration files under /node_modules/ts-plus-plus, keyed by path. */
  const files: Readonly<Record<string, string>>;
  export default files;
}

declare module "monaco-editor/languages/definitions/typescript/typescript.js" {
  import type { languages } from "monaco-editor";
  export const conf: languages.LanguageConfiguration;
  export const language: languages.IMonarchLanguage & { keywords: string[]; tokenizer: Record<string, languages.IMonarchLanguageRule[]> };
}
