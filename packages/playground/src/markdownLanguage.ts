import { conf, language } from "monaco-editor/languages/definitions/markdown/markdown.js";
import * as monaco from "./monaco";

export const markdownLanguageId = "markdown";

/** Monaco's Markdown highlighting, for the README an example project carries. */
export function registerMarkdownLanguage(): void {
  monaco.languages.register({ id: markdownLanguageId, aliases: ["Markdown"], extensions: [".md"] });
  monaco.languages.setLanguageConfiguration(markdownLanguageId, conf);
  monaco.languages.setMonarchTokensProvider(markdownLanguageId, language);
}
