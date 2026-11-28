import skills from "virtual:tspp-skills";
import type * as monaco from "./monaco";
import type { DiagnosticInfo, FeatureDefinition } from "./protocol";

export interface PromptContext {
  readonly activeFile: string;
  readonly features: readonly string[];
  readonly definitions: readonly FeatureDefinition[];
  readonly files: Readonly<Record<string, string>>;
  readonly models?: ReadonlyMap<string, monaco.editor.ITextModel>;
}

export type ErrorCopyMode = "concise" | "full";

function codeFenceLanguage(path: string): string {
  if (path.endsWith(".tspp")) return "tspp";
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return "ts";
  if (path.endsWith(".json") || path.endsWith(".jsonc")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "";
}

function formatCodeSection(path: string, content: string): string {
  const displayPath = path.replace(/^\//, "");
  const lang = codeFenceLanguage(path);
  return `### \`${displayPath}\`\n\n\`\`\`${lang}\n${content}\n\`\`\``;
}

function formatEnabledFeatures(features: readonly string[], definitions: readonly FeatureDefinition[]): string {
  if (!features.length) return "- (none)";
  return features.map(id => {
    const def = definitions.find(candidate => candidate.id === id);
    return def ? `- \`${def.id}\` (\`${def.packageName}\`): ${def.name}` : `- \`${id}\``;
  }).join("\n");
}

/** Concatenates the generated TS++ skill entry and all reference docs into one markdown document. */
export function formatFullSkillContext(): string {
  const sections: string[] = [];
  for (const [relativePath, content] of Object.entries(skills.files)) {
    sections.push(`<!-- skill-file: ${relativePath} -->\n\n${content.trimEnd()}`);
  }
  if (!sections.length && skills.entry) {
    sections.push(skills.entry.trimEnd());
  }
  return sections.join("\n\n---\n\n");
}

function resolveLiveFiles(context: PromptContext): Readonly<Record<string, string>> {
  if (!context.models?.size) return context.files;
  return {
    ...context.files,
    ...Object.fromEntries([...context.models].map(([path, model]) => [path, model.getValue()])),
  };
}

function formatWorkspaceFiles(context: PromptContext, primaryPath: string): string {
  const files = resolveLiveFiles(context);
  const parts: string[] = [];
  const primaryContent = files[primaryPath];
  if (primaryContent !== undefined) {
    parts.push(formatCodeSection(primaryPath, primaryContent));
  }
  const configContent = files["/tsppconfig.json"];
  if (primaryPath !== "/tsppconfig.json" && configContent !== undefined) {
    parts.push(formatCodeSection("/tsppconfig.json", configContent));
  }
  for (const [path, content] of Object.entries(files)) {
    if (path === primaryPath || path === "/tsppconfig.json" || path === "/README.md" || path === "/package.json") continue;
    parts.push(formatCodeSection(path, content));
  }
  return parts.join("\n\n");
}

/** Builds a self-contained AI prompt with the full TS++ skills and current playground state. */
export function buildCopyPromptText(context: PromptContext): string {
  const activeDisplay = context.activeFile ? context.activeFile.replace(/^\//, "") : "(none)";
  const skillText = formatFullSkillContext();
  const filesSection = formatWorkspaceFiles(context, context.activeFile);

  return [
    "# TS++ Playground Context",
    "",
    "## TS++ Skills Reference",
    "",
    skillText,
    "",
    "## Current Playground State",
    "",
    `- Active file: \`${activeDisplay}\``,
    "- Enabled features:",
    formatEnabledFeatures(context.features, context.definitions),
    "",
    "## Project Files",
    "",
    filesSection || "(no files)",
    "",
    "## My Request",
    "",
    "<!-- Describe what you want to write or modify below -->",
    "",
  ].join("\n");
}

export interface LocatedDiagnostic {
  readonly problem: DiagnosticInfo;
  readonly position?: { readonly lineNumber: number; readonly column: number };
}

/** Builds an AI-ready report for all diagnostics, either concise (errors + code) or with full TS++ skill context. */
export function buildErrorsPromptText(
  diagnostics: readonly LocatedDiagnostic[],
  context: PromptContext,
  mode: ErrorCopyMode,
): string {
  const sections: string[] = [];

  if (mode === "full") {
    sections.push(
      "# TS++ Skills Reference",
      "",
      formatFullSkillContext(),
      "",
    );
  }

  const formattedDiagnostics = diagnostics.map(({ problem, position }, index) => {
    const targetPath = problem.fileName ?? context.activeFile;
    const displayPath = targetPath.replace(/^\//, "");
    const location = position ? `${displayPath}:${position.lineNumber}:${position.column}` : displayPath;
    const codeTag = problem.code ? ` (TS${problem.code})` : "";
    return `${index + 1}. [${problem.category}] \`${location}\` — ${problem.message}${codeTag}`;
  });

  sections.push(
    `# TS++ Diagnostics (${diagnostics.length})`,
    "",
    ...formattedDiagnostics,
    "",
    "- Enabled features:",
    formatEnabledFeatures(context.features, context.definitions),
    "",
    "## Relevant Code",
    "",
    formatWorkspaceFiles(context, context.activeFile) || "(no files)",
    "",
    "Please explain the causes of these diagnostics and provide the fixed code.",
    "",
  );

  return sections.join("\n");
}

/** Copies text to the clipboard with a textarea fallback for non-secure contexts. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  }
  catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  }
}

const feedbackTimers = new WeakMap<HTMLButtonElement, number>();

/** Briefly updates a copy button's visual state to confirm clipboard copy succeeded. */
export function flashCopied(button: HTMLButtonElement, label?: string): void {
  const previous = feedbackTimers.get(button);
  if (previous !== undefined) clearTimeout(previous);
  if (label !== undefined && !button.dataset.originalText) {
    button.dataset.originalText = button.textContent ?? "";
  }
  button.classList.add("copied");
  if (label !== undefined) button.textContent = label;
  const timer = window.setTimeout(() => {
    button.classList.remove("copied");
    if (button.dataset.originalText !== undefined) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
    feedbackTimers.delete(button);
  }, 1500);
  feedbackTimers.set(button, timer);
}

/** Wires the header "Copy Prompt" button to copy the full skill docs and live project state. */
export function setupCopyPromptButton(button: HTMLButtonElement, context: () => PromptContext): void {
  button.onclick = async () => {
    if (await copyText(buildCopyPromptText(context()))) flashCopied(button, "Copied!");
  };
}
