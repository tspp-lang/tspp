/**
 * The language worker: one in-memory TS++ language service over the playground's
 * project files, built from the compiler sources (see the compiler-source plugin in
 * vite.config.ts). It also hosts what the compiler needs from a non-Node runtime:
 * evaluating compile-time macros and solving formal contracts with Z3.
 */
import * as ts from "ts-plus-plus/source";
import type { TSPPPlugin } from "@tspp/plugin-sdk";
import dependentTypesModule from "@tspp/plugin-dependent-types";
import * as formalVerificationNamespace from "@tspp/plugin-formal-verification";
import macrosModule, { getMacroExpansions } from "@tspp/plugin-macros";
import modernSyntaxModule from "@tspp/plugin-modern-syntax";
import nominalTypesModule from "@tspp/plugin-nominal-types";
import operatorSectionsModule from "@tspp/plugin-operator-sections";
import staticInterfaceMembersModule from "@tspp/plugin-static-interface-members";
import typeComputationModule from "@tspp/plugin-type-computation";
import libs from "virtual:tspp-libs";
import type { Cancel, CompletionEntry, DiagnosticInfo, Location, OutputCategory, OutputItem, OutputSnapshot, QuickInfo, Request, Response, SignatureHelp, Span, WorkerApi, WorkerEvent } from "../protocol";
import { createBrowserZ3Solver } from "../z3Bridge";

interface AnalysisDiagnostic {
  readonly fileName: string;
  readonly start: number;
  readonly length: number;
  readonly message: string;
  readonly code: number;
  readonly category: "warning" | "error";
}

interface AnalysisArtifact extends Span {
  readonly kind: string;
  readonly fileName: string;
  readonly name: string;
  readonly content: string;
  readonly status?: "proved" | "failed" | "unknown" | "error";
}

const tspp = ts as typeof ts & {
  runTSPPProgramAnalyzers(program: ts.Program): Promise<readonly AnalysisDiagnostic[]>;
  getTSPPAnalysisArtifacts(program: ts.Program, fileName?: string): readonly AnalysisArtifact[];
};

function pluginDefault(module: unknown): TSPPPlugin {
  const candidate = module as TSPPPlugin;
  return candidate.manifest ? candidate : (module as { default: TSPPPlugin }).default;
}

const formalVerification = ("formalVerificationPlugin" in formalVerificationNamespace
  ? formalVerificationNamespace
  : (formalVerificationNamespace as unknown as { default: typeof formalVerificationNamespace }).default);
const plugins: readonly TSPPPlugin[] = [
  pluginDefault(modernSyntaxModule),
  pluginDefault(nominalTypesModule),
  pluginDefault(typeComputationModule),
  pluginDefault(staticInterfaceMembersModule),
  pluginDefault(dependentTypesModule),
  formalVerification.formalVerificationPlugin,
  pluginDefault(macrosModule),
  pluginDefault(operatorSectionsModule),
];
const pluginById = new Map(plugins.map(plugin => [plugin.manifest.id, plugin]));
const featureDefinitions = plugins.map(plugin => ({
  id: plugin.manifest.id,
  name: plugin.manifest.displayName ?? plugin.manifest.id,
  dependencies: plugin.manifest.id === "formal-verification/z3" ? ["nominal-types"] : [],
  description: plugin.manifest.capabilities?.join(" · "),
}));

const files = new Map<string, { text: string; version: number }>();
const options: ts.CompilerOptions = createOptions();
let service: ts.LanguageService | undefined;

/** Declarations for `ts-plus-plus` and its subpaths, loaded once a file imports the package. */
let packageTypes: Readonly<Record<string, string>> = {};
const packageImport = /["'](?:@tspp\/[^"']+|ts-plus-plus(?:\/[\w-]+)?)["']/;

function createOptions(): ts.CompilerOptions {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    declaration: true,
    noEmit: false,
    noEmitOnError: false,
    skipLibCheck: true,
    allowNonTsExtensions: true,
  };
}

function post(message: Response | WorkerEvent) {
  self.postMessage(message);
}

const isSourceFile = (path: string) => /\.(tspp|ts)$/.test(path) && !/\.d\.(tspp|ts)$/.test(path);

function readFile(path: string): string | undefined {
  return files.get(path)?.text ?? packageTypes[path] ?? libs[path.slice(path.lastIndexOf("/") + 1)];
}

/** Resolves a relative module specifier against the importing file, POSIX style. */
function resolvePath(containingFile: string, specifier: string): string {
  const parts = containingFile.replaceAll("\\", "/").split("/").filter(Boolean).slice(0, -1);
  for (const part of specifier.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
}

/**
 * CompilerHost.evaluateMacroModule: runs an emitted CommonJS macro module in this
 * worker. `requireLocal` covers local sources, the compiler's own facades and
 * resolveMacroModule; anything else is reported as missing.
 */
function evaluateMacroModule(javascript: string, fileName: string, requireLocal: (specifier: string) => unknown, module: { exports: Record<string, unknown> }) {
  const require = (specifier: string) => {
    const local = requireLocal(specifier);
    if (local !== undefined) return local;
    throw new Error(`Cannot find module '${specifier}': the playground provides project files, 'ts-plus-plus/macros' and 'ts-plus-plus/smt'.`);
  };
  const directory = fileName.slice(0, fileName.lastIndexOf("/")) || "/";
  new Function("require", "exports", "module", "__filename", "__dirname", javascript)(require, module.exports, module, fileName, directory);
}

/** CompilerHost.resolveMacroModule: JSON files of the project, as Node's require would load them. */
function resolveMacroModule(specifier: string, containingFile: string): unknown {
  if (!specifier.startsWith(".") || !specifier.endsWith(".json")) return undefined;
  const text = files.get(resolvePath(containingFile, specifier))?.text;
  return text === undefined ? undefined : JSON.parse(text);
}

const host: ts.LanguageServiceHost & {
  onTSPPProgramInvalidated(): void;
  setCompilerHost(compilerHost: ts.CompilerHost & {
    evaluateMacroModule?: typeof evaluateMacroModule;
    resolveMacroModule?: typeof resolveMacroModule;
  }): void;
} = {
  getCompilationSettings: () => options,
  getScriptFileNames: () => [...files.keys()].filter(isSourceFile),
  getScriptVersion: path => String(files.get(path)?.version ?? 0),
  getScriptSnapshot: path => {
    const content = readFile(path);
    return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content);
  },
  getScriptKind: path => path.endsWith(".tspp") ? ts.ScriptKind.TS : ts.ScriptKind.Unknown,
  getCurrentDirectory: () => "/",
  getDefaultLibFileName: compilerOptions => "/" + ts.getDefaultLibFileName(compilerOptions),
  fileExists: path => readFile(path) !== undefined,
  readFile,
  directoryExists: directory => {
    const prefix = directory.endsWith("/") ? directory : directory + "/";
    return [...files.keys(), ...Object.keys(packageTypes)].some(path => path.startsWith(prefix));
  },
  useCaseSensitiveFileNames: () => true,
  setCompilerHost(compilerHost) {
    compilerHost.evaluateMacroModule = evaluateMacroModule;
    compilerHost.resolveMacroModule = resolveMacroModule;
  },
  // Macro expansion and verification finish after the request that started them.
  onTSPPProgramInvalidated: () => post({ event: "analysisSettled" }),
};

function languageService(): ts.LanguageService {
  return service ??= ts.createLanguageService(host);
}

// Program analyzers (formal verification solves with Z3) run in the background, as in
// the language server: diagnostics answer at once and gain analyzer results once the run
// for the current Program settles.
let analyzedProgram: ts.Program | undefined;
let analyzingProgram: ts.Program | undefined;
let analysisDiagnostics: readonly ts.Diagnostic[] = [];
/** Bumped by every project change, so a run for an outdated Program is not reported. */
let projectVersion = 0;

function startAnalysis(program: ts.Program): void {
  if (analyzedProgram === program || analyzingProgram === program) return;
  analyzingProgram = program;
  const version = projectVersion;
  const settle = (diagnostics: readonly ts.Diagnostic[]) => {
    if (analyzingProgram !== program) return;
    analyzingProgram = undefined;
    if (projectVersion !== version) return;
    analyzedProgram = program;
    analysisDiagnostics = diagnostics;
    post({ event: "analysisSettled" });
  };
  tspp.runTSPPProgramAnalyzers(program).then(
    analyzed => settle(analyzed.map(diagnostic => ({
      file: program.getSourceFile(diagnostic.fileName),
      start: diagnostic.start,
      length: diagnostic.length,
      messageText: diagnostic.message,
      code: diagnostic.code,
      category: diagnostic.category === "error" ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
    }))),
    error => {
      console.error(`[tspp worker] program analysis failed: ${error instanceof Error ? error.stack : error}`);
      // a crashed analyzer must not look like a verified program
      settle([{
        file: undefined,
        start: undefined,
        length: undefined,
        messageText: `Program analysis failed: ${error instanceof Error ? error.message : String(error)}`,
        code: 0,
        category: ts.DiagnosticCategory.Error,
      }]);
    },
  );
}

/** Analyzer diagnostics of the current Program for one file, once its run has settled. */
function settledAnalysisDiagnostics(program: ts.Program, fileName: string): readonly ts.Diagnostic[] {
  if (analyzedProgram !== program) {
    startAnalysis(program);
    return [];
  }
  return analysisDiagnostics.filter(diagnostic => !diagnostic.file || diagnostic.file.fileName === fileName);
}

async function loadPackageTypesIfImported(): Promise<void> {
  if (Object.keys(packageTypes).length || ![...files.values()].some(file => packageImport.test(file.text))) return;
  packageTypes = (await import("virtual:tspp-package-types")).default;
}

const categories: Record<ts.DiagnosticCategory, DiagnosticInfo["category"]> = {
  [ts.DiagnosticCategory.Error]: "error",
  [ts.DiagnosticCategory.Warning]: "warning",
  [ts.DiagnosticCategory.Suggestion]: "suggestion",
  [ts.DiagnosticCategory.Message]: "message",
};

function toDiagnostic(diagnostic: ts.Diagnostic): DiagnosticInfo {
  return {
    span: diagnostic.file && diagnostic.start !== undefined ? { start: diagnostic.start, length: diagnostic.length ?? 0 } : undefined,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    code: diagnostic.code,
    category: categories[diagnostic.category],
    unnecessary: !!diagnostic.reportsUnnecessary,
    deprecated: !!diagnostic.reportsDeprecated,
  };
}

const contains = (span: { start: number; length: number }, offset: number) => span.start <= offset && offset <= span.start + span.length;

/** Normalized type for a type position, as the VS Code extension shows it on hover. */
function normalizedTypeAt(fileName: string, offset: number): QuickInfo["normalized"] & { span: Span } | undefined {
  void fileName;
  void offset;
  return undefined;
}

function tagToString(tag: ts.JSDocTagInfo): string {
  const body = ts.displayPartsToString(tag.text);
  return `*@${tag.name}*${body ? ` — ${body}` : ""}`;
}

function outputCategory(fileName: string): Pick<OutputItem, "category" | "language"> | undefined {
  if (fileName.endsWith(".d.tspp")) return { category: "dtspp", language: "tspp" };
  if (fileName.endsWith(".d.ts")) return { category: "dts", language: "typescript" };
  if (/\.(?:c|m)?js$/.test(fileName)) return { category: "javascript", language: "javascript" };
  return undefined;
}

function expandedSource(program: ts.Program, fileName: string): OutputItem | undefined {
  const source = files.get(fileName)?.text;
  const expansions = [...getMacroExpansions(program, fileName)];
  if (source === undefined || !expansions.length) return undefined;
  let content = source;
  for (const expansion of expansions.sort((left, right) => right.start - left.start)) {
    content = content.slice(0, expansion.start) + expansion.text + content.slice(expansion.start + expansion.length);
  }
  return {
    id: `macro:${fileName}`,
    category: "macro",
    label: fileName.slice(fileName.lastIndexOf("/") + 1),
    language: "tspp",
    content,
    fileName,
  };
}

async function createOutputs(fileName: string, requested: OutputCategory): Promise<OutputSnapshot> {
  const program = languageService().getProgram();
  if (!program) return { items: [], diagnostics: [] };
  const items: OutputItem[] = [];
  let diagnostics: readonly ts.Diagnostic[] = [];
  if (requested === "javascript" || requested === "dts" || requested === "dtspp") {
    const emit = program.emit(undefined, (outputName, content) => {
      const type = outputCategory(outputName);
      if (!type || type.category !== requested) return;
      items.push({
        id: `${type.category}:${outputName}`,
        ...type,
        label: outputName.replace(/^\//, ""),
        content,
      });
    });
    // whole-program diagnostics only tell whether emitted files may be wrong
    diagnostics = [...emit.diagnostics, ...program.getOptionsDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()];
  }
  if (requested === "macro") {
    const macro = expandedSource(program, fileName);
    if (macro) items.push(macro);
  }
  if (requested === "smt") {
    await tspp.runTSPPProgramAnalyzers(program);
    for (const artifact of tspp.getTSPPAnalysisArtifacts(program, fileName)) {
      if (artifact.kind !== "formal-verification/smt") continue;
      items.push({
        id: `smt:${artifact.fileName}:${artifact.start}:${artifact.name}`,
        category: "smt",
        label: artifact.name,
        language: "plaintext",
        content: artifact.content,
        fileName: artifact.fileName,
        span: { start: artifact.start, length: artifact.length },
        status: artifact.status,
      });
    }
  }
  return { items, diagnostics: diagnostics.map(toDiagnostic) };
}

const api: WorkerApi = {
  init(z3) {
    formalVerification.configureZ3Solver(createBrowserZ3Solver(z3, busy => post({ event: "solver", busy })));
    return { version: ts.version, features: featureDefinitions };
  },

  setProject(projectFiles, features) {
    if (!service) {
      for (const id of features) {
        const plugin = pluginById.get(id);
        if (!plugin) throw new Error(`Unknown TS++ capsule '${id}'.`);
        ts.registerTSPPCompilerPlugin(plugin);
      }
    }
    for (const [fileName, text] of Object.entries(projectFiles)) {
      const file = files.get(fileName);
      if (file?.text !== text) files.set(fileName, { text, version: (file?.version ?? 0) + 1 });
    }
    for (const fileName of files.keys()) {
      if (!(fileName in projectFiles)) files.delete(fileName);
    }
    projectVersion++;
  },

  editFile(fileName, text) {
    const file = files.get(fileName);
    if (file && file.text !== text) {
      files.set(fileName, { text, version: file.version + 1 });
      projectVersion++;
    }
  },

  diagnostics(fileName) {
    if (!isSourceFile(fileName)) return [];
    const activeService = languageService();
    const diagnostics = [
      ...activeService.getCompilerOptionsDiagnostics(),
      ...activeService.getSyntacticDiagnostics(fileName),
      ...activeService.getSemanticDiagnostics(fileName),
    ];
    try {
      diagnostics.push(...activeService.getSuggestionDiagnostics(fileName));
    }
    catch {
      // Suggestions are optional; a failure there must not hide the errors above.
    }
    const program = activeService.getProgram();
    if (program) diagnostics.push(...settledAnalysisDiagnostics(program, fileName));
    return diagnostics.map(toDiagnostic);
  },

  outputs(fileName, category) {
    return createOutputs(fileName, category);
  },

  quickInfo(fileName, offset) {
    const activeService = languageService();
    const info = activeService.getQuickInfoAtPosition(fileName, offset);
    const normalized = normalizedTypeAt(fileName, offset);
    const program = activeService.getProgram();
    const expansion = program && getMacroExpansions(program, fileName).find(candidate => contains(candidate, offset));
    const artifact = program && tspp.getTSPPAnalysisArtifacts(program, fileName).find(candidate => contains(candidate, offset));
    const span = info?.textSpan ?? normalized?.span ?? expansion ?? artifact;
    if (!span) return undefined;
    return {
      span: { start: span.start, length: span.length },
      display: info && ts.displayPartsToString(info.displayParts),
      documentation: info && ts.displayPartsToString(info.documentation),
      tags: info?.tags?.map(tagToString) ?? [],
      normalized: normalized && { text: normalized.text, label: normalized.label, classification: normalized.classification },
      macroExpansion: expansion && { macroName: expansion.macroName, text: expansion.text },
      verification: artifact && { status: artifact.status ?? "unknown", message: artifact.name, counterexample: artifact.content },
    };
  },

  completions(fileName, offset, triggerCharacter) {
    const info = languageService().getCompletionsAtPosition(fileName, offset, {
      triggerCharacter: triggerCharacter as ts.CompletionsTriggerCharacter | undefined,
      includeCompletionsForModuleExports: true,
      includeCompletionsWithInsertText: true,
      includeCompletionsWithSnippetText: true,
      includeCompletionsWithClassMemberSnippets: true,
      includeCompletionsWithObjectLiteralMethodSnippets: true,
      includeAutomaticOptionalChainCompletions: true,
      useLabelDetailsInCompletionEntries: true,
    });
    if (!info) return undefined;
    const entries = info.entries.map((entry): CompletionEntry => ({
      name: entry.name,
      kind: entry.kind,
      kindModifiers: entry.kindModifiers,
      sortText: entry.sortText,
      insertText: entry.insertText,
      isSnippet: entry.isSnippet,
      replacementSpan: entry.replacementSpan,
      labelDetail: entry.labelDetails?.detail,
      labelDescription: entry.labelDetails?.description,
      source: entry.source,
      data: entry.data,
    }));
    return { entries, isIncomplete: !!info.isIncomplete };
  },

  completionDetails(fileName, offset, name, source, data) {
    const details = languageService().getCompletionEntryDetails(fileName, offset, name, undefined, source, undefined, data as ts.CompletionEntryData | undefined);
    if (!details) return undefined;
    const documentation = [ts.displayPartsToString(details.documentation), ...details.tags?.map(tagToString) ?? []];
    return { display: ts.displayPartsToString(details.displayParts), documentation: documentation.filter(Boolean).join("\n\n") };
  },

  signatureHelp(fileName, offset, triggerCharacter, isRetrigger) {
    const triggerReason: ts.SignatureHelpTriggerReason = triggerCharacter
      ? { kind: isRetrigger ? "retrigger" : "characterTyped", triggerCharacter: triggerCharacter as ts.SignatureHelpTriggerCharacter }
      : { kind: "invoked" };
    const help = languageService().getSignatureHelpItems(fileName, offset, { triggerReason });
    if (!help) return undefined;
    const items: SignatureHelp["items"] = help.items.map(item => {
      let label = ts.displayPartsToString(item.prefixDisplayParts);
      const separator = ts.displayPartsToString(item.separatorDisplayParts);
      const parameters = item.parameters.map((parameter, i) => {
        if (i > 0) label += separator;
        const start = label.length;
        label += ts.displayPartsToString(parameter.displayParts);
        return { label: [start, label.length] as [number, number], documentation: ts.displayPartsToString(parameter.documentation) };
      });
      label += ts.displayPartsToString(item.suffixDisplayParts);
      return { label, documentation: ts.displayPartsToString(item.documentation), parameters };
    });
    return { items, activeSignature: help.selectedItemIndex, activeParameter: help.argumentIndex };
  },

  definition(fileName, offset) {
    return (languageService().getDefinitionAtPosition(fileName, offset) ?? [])
      .filter(definition => files.has(definition.fileName))
      .map((definition): Location => ({ fileName: definition.fileName, span: definition.textSpan }));
  },
};

/** Resolves after any messages already posted to the worker, such as cancellations, are delivered. */
function yieldToMessages(): Promise<void> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => resolve();
    channel.port2.postMessage(undefined);
  });
}

const cancelled = new Set<number>();
let lastStarted = 0;

/** Starts one request; the returned box carries its result without waiting for it. */
async function start({ id, method, args }: Request): Promise<{ result: unknown } | undefined> {
  await yieldToMessages();
  lastStarted = id;
  if (cancelled.delete(id)) return undefined;
  await loadPackageTypesIfImported();
  return { result: (api[method] as (...a: unknown[]) => unknown)(...args) };
}

function fail(method: string, id: number, error: unknown) {
  console.error(`[tspp worker] ${method} failed: ${error instanceof Error ? error.stack : error}`);
  post({ id, error: error instanceof Error ? error.message : String(error) });
}

// Requests start strictly in arrival order, even when one waits for the package types.
// Only the synchronous part is ordered: a request whose answer is asynchronous (SMT
// outputs wait for Z3) must not hold back the hovers and completions behind it.
let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (event: MessageEvent<Request | Cancel>) => {
  const message = event.data;
  if ("cancel" in message) {
    if (message.cancel > lastStarted) cancelled.add(message.cancel);
    return;
  }
  const started = queue.then(() => start(message));
  queue = started.catch(() => undefined);
  started.then(
    async box => {
      if (!box) return;
      try {
        post({ id: message.id, result: await box.result });
      }
      catch (error) {
        fail(message.method, message.id, error);
      }
    },
    error => fail(message.method, message.id, error),
  );
};
