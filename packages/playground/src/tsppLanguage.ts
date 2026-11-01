import { conf, language as typescript } from "monaco-editor/languages/definitions/typescript/typescript.js";
import pluginKeywords from "virtual:tspp-editor-keywords";
import * as monaco from "./monaco";

export const languageId = "tspp";

/** Monaco's TypeScript grammar plus lexical metadata owned by the feature capsules. */
export function registerTsppLanguage() {
  monaco.languages.register({ id: languageId, extensions: [".tspp"], aliases: ["TS++"] });
  monaco.languages.setLanguageConfiguration(languageId, conf);
  monaco.languages.setMonarchTokensProvider(languageId, {
    ...typescript,
    tokenPostfix: ".tspp",
    keywords: [...new Set([...typescript.keywords, ...pluginKeywords])],
    tokenizer: {
      ...typescript.tokenizer,
      common: [[/\b(?:Prop|Type\d*)\b/, "type"], ...typescript.tokenizer.common],
    },
  } as monaco.languages.IMonarchLanguage);
}
