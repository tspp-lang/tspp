/** Monaco providers for the tspp language, each a thin translation of one worker call. */
import type { LanguageClient } from "./client";
import * as monaco from "./monaco";
import type { CompletionEntry, DiagnosticInfo, Span } from "./protocol";
import { languageId } from "./tsppLanguage";

const { CompletionItemKind } = monaco.languages;
const completionKinds: Record<string, monaco.languages.CompletionItemKind> = {
  "keyword": CompletionItemKind.Keyword,
  "primitive type": CompletionItemKind.Keyword,
  "module": CompletionItemKind.Module,
  "external module name": CompletionItemKind.Module,
  "class": CompletionItemKind.Class,
  "local class": CompletionItemKind.Class,
  "interface": CompletionItemKind.Interface,
  "type": CompletionItemKind.Struct,
  "type parameter": CompletionItemKind.TypeParameter,
  "enum": CompletionItemKind.Enum,
  "enum member": CompletionItemKind.EnumMember,
  "var": CompletionItemKind.Variable,
  "local var": CompletionItemKind.Variable,
  "let": CompletionItemKind.Variable,
  "parameter": CompletionItemKind.Variable,
  "const": CompletionItemKind.Constant,
  "function": CompletionItemKind.Function,
  "local function": CompletionItemKind.Function,
  "method": CompletionItemKind.Method,
  "constructor": CompletionItemKind.Constructor,
  "property": CompletionItemKind.Field,
  "getter": CompletionItemKind.Property,
  "setter": CompletionItemKind.Property,
  "accessor": CompletionItemKind.Property,
  "alias": CompletionItemKind.Reference,
  "string": CompletionItemKind.Value,
};

function toRange(model: monaco.editor.ITextModel, span: Span): monaco.IRange {
  const start = model.getPositionAt(span.start);
  const end = model.getPositionAt(span.start + span.length);
  return { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column };
}

const codeBlock = (code: string) => "```" + languageId + "\n" + code + "\n```";

type TsppCompletionItem = monaco.languages.CompletionItem & { entry: CompletionEntry; fileName: string; offset: number };

export function registerProviders(client: LanguageClient) {
  monaco.languages.registerHoverProvider(languageId, {
    async provideHover(model, position) {
      const info = await client.quickInfo(model.uri.path, model.getOffsetAt(position));
      if (!info) return undefined;
      const contents: monaco.IMarkdownString[] = [];
      if (info.display) contents.push({ value: codeBlock(info.display) });
      if (info.normalized) {
        const { text, label, classification } = info.normalized;
        contents.push({ value: `Normalized: \`${text}\` · ${label}: \`${classification}\`` });
      }
      if (info.macroExpansion) {
        const { macroName, text } = info.macroExpansion;
        contents.push({
          value: `**TS++ macro expansion: \`${macroName}\`**\n\n`
            + (text.trim() ? codeBlock(text) : "This is a validation-only macro; it emits no statements."),
        });
      }
      if (info.verification) {
        const { status, message, counterexample } = info.verification;
        const icon = status === "proved" ? "✓" : status === "failed" ? "✗" : "?";
        contents.push({
          value: `**${icon} TS++ verification: ${status}**\n\n${message}`
            + (counterexample ? `\n\n**Counterexample**\n\n${codeBlock(counterexample)}` : ""),
        });
      }
      const documentation = [info.documentation, ...info.tags].filter(Boolean).join("\n\n");
      if (documentation) contents.push({ value: documentation });
      return { range: toRange(model, info.span), contents };
    },
  });

  monaco.languages.registerCompletionItemProvider(languageId, {
    triggerCharacters: [".", '"', "'", "`", "/", "@", "<", "#", " "],
    async provideCompletionItems(model, position, context) {
      const offset = model.getOffsetAt(position);
      const info = await client.completions(model.uri.path, offset, context.triggerCharacter);
      if (!info) return undefined;
      const word = model.getWordUntilPosition(position);
      const wordRange = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      const suggestions = info.entries.map((entry): TsppCompletionItem => ({
        label: entry.labelDetail || entry.labelDescription
          ? { label: entry.name, detail: entry.labelDetail, description: entry.labelDescription }
          : entry.name,
        kind: completionKinds[entry.kind] ?? CompletionItemKind.Property,
        sortText: entry.sortText,
        insertText: entry.insertText ?? entry.name,
        insertTextRules: entry.isSnippet ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
        range: entry.replacementSpan ? toRange(model, entry.replacementSpan) : wordRange,
        tags: entry.kindModifiers?.includes("deprecated") ? [monaco.languages.CompletionItemTag.Deprecated] : undefined,
        entry,
        fileName: model.uri.path,
        offset,
      }));
      return { suggestions, incomplete: info.isIncomplete };
    },
    async resolveCompletionItem(item) {
      const { entry, fileName, offset } = item as TsppCompletionItem;
      const details = await client.completionDetails(fileName, offset, entry.name, entry.source, entry.data);
      if (!details) return item;
      return { ...item, detail: details.display, documentation: { value: details.documentation } };
    },
  });

  monaco.languages.registerSignatureHelpProvider(languageId, {
    signatureHelpTriggerCharacters: ["(", ",", "<"],
    signatureHelpRetriggerCharacters: [")"],
    async provideSignatureHelp(model, position, _token, context) {
      const help = await client.signatureHelp(model.uri.path, model.getOffsetAt(position), context.triggerCharacter, context.isRetrigger);
      if (!help) return undefined;
      return {
        value: {
          signatures: help.items.map(item => ({
            label: item.label,
            documentation: { value: item.documentation },
            parameters: item.parameters.map(parameter => ({ label: parameter.label, documentation: { value: parameter.documentation } })),
          })),
          activeSignature: help.activeSignature,
          activeParameter: help.activeParameter,
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerDefinitionProvider(languageId, {
    async provideDefinition(model, position) {
      const locations = await client.definition(model.uri.path, model.getOffsetAt(position));
      return locations.flatMap(({ fileName, span }) => {
        const target = monaco.editor.getModel(monaco.Uri.file(fileName));
        return target ? [{ uri: target.uri, range: toRange(target, span) }] : [];
      });
    },
  });
}

const severities: Record<DiagnosticInfo["category"], monaco.MarkerSeverity> = {
  error: monaco.MarkerSeverity.Error,
  warning: monaco.MarkerSeverity.Warning,
  suggestion: monaco.MarkerSeverity.Hint,
  message: monaco.MarkerSeverity.Info,
};

/** Editor markers for diagnostics with a position; positionless ones only appear in the problems list. */
export function setDiagnosticMarkers(model: monaco.editor.ITextModel, diagnostics: readonly DiagnosticInfo[]) {
  const markers = diagnostics.filter(d => d.span).map((d): monaco.editor.IMarkerData => ({
    ...toRange(model, { start: d.span!.start, length: Math.max(d.span!.length, 1) }),
    severity: severities[d.category],
    message: d.message,
    code: String(d.code),
    source: "ts++",
    tags: [
      ...d.unnecessary ? [monaco.MarkerTag.Unnecessary] : [],
      ...d.deprecated ? [monaco.MarkerTag.Deprecated] : [],
    ],
  }));
  monaco.editor.setModelMarkers(model, languageId, markers);
}
