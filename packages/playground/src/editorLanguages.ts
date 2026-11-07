import { jsoncLanguageId, registerJsoncLanguage } from "./jsoncLanguage";
import { markdownLanguageId, registerMarkdownLanguage } from "./markdownLanguage";
import { registerSmtLanguage } from "./smtLanguage";
import { languageId, registerTsppLanguage } from "./tsppLanguage";

/** Registers every language the editor shows: TS++ sources, project JSON, READMEs and solver artifacts. */
export function registerEditorLanguages(): void {
  registerTsppLanguage();
  registerJsoncLanguage();
  registerSmtLanguage();
  registerMarkdownLanguage();
}

export const isSourceFile = (path: string) => /\.(tspp|ts)$/.test(path);

/** Files the project tree opens in the editor; anything else is kept as a resource. */
export const isEditorFile = (path: string) => isSourceFile(path) || /\.(?:json|md)$/.test(path);

export function editorLanguage(path: string): string {
  if (path.endsWith(".json")) return jsoncLanguageId;
  if (path.endsWith(".md")) return markdownLanguageId;
  return isSourceFile(path) ? languageId : "plaintext";
}
