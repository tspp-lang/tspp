import { conf, language as typescript } from "monaco-editor/languages/definitions/typescript/typescript.js";
import * as monaco from "./monaco";

export const languageId = "tspp";

/** TS++ declaration, contract and computation keywords (see the VS Code grammars in packages/vscode-extension/syntaxes). */
const tsppKeywords = ["data", "newtype", "match", "mltt", "macro", "requires", "ensures", "invariant", "predicate", "assert", "assume", "use"];

/** monaco's TypeScript Monarch grammar plus the TS++ keywords and universe names. */
export function registerTsppLanguage() {
  monaco.languages.register({ id: languageId, extensions: [".tspp"], aliases: ["TS++"] });
  monaco.languages.setLanguageConfiguration(languageId, conf);
  monaco.languages.setMonarchTokensProvider(languageId, {
    ...typescript,
    tokenPostfix: ".tspp",
    keywords: [...typescript.keywords, ...tsppKeywords],
    tokenizer: {
      ...typescript.tokenizer,
      common: [[/\b(?:Prop|Type\d*)\b/, "type"], ...typescript.tokenizer.common],
    },
  } as monaco.languages.IMonarchLanguage);
}
