/**
 * The language worker: one in-memory TS++ language service over the playground's
 * project files, built from the compiler sources (see the compiler-source plugin in
 * vite.config.ts). It also hosts what the compiler needs from a non-Node runtime:
 * evaluating compile-time macros and solving formal contracts with Z3.
 */
import * as ts from "ts-plus-plus/source";
import libs from "virtual:tspp-libs";
import type { CompletionEntry, DiagnosticInfo, Location, QuickInfo, Request, Response, SignatureHelp, Span, WorkerApi, WorkerEvent } from "../protocol";
import { createZ3Solver } from "./z3Bridge";

const files = new Map<string, { text: string; version: number }>();
let options: ts.CompilerOptions = createOptions([]);
let solveVerificationQueries: ((requests: readonly ts.VerificationSolverRequest[]) => Promise<readonly ts.VerificationSolverResponse[]>) | undefined;

/** Declarations for `ts-plus-plus` and its subpaths, loaded once a file imports the package. */
let packageTypes: Readonly<Record<string, string>> = {};
const packageImport = /["']ts-plus-plus(?:\/[\w-]+)?["']/;

function createOptions(features: readonly string[]): ts.CompilerOptions {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    allowNonTsExtensions: true,
    tsppFeatures: [...features],
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
  const parts = containingFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
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

const host: ts.LanguageServiceHost = {
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
    compilerHost.solveVerificationQueries = requests =>
      solveVerificationQueries ? solveVerificationQueries(requests) : Promise.reject(new Error("Z3 is not configured"));
  },
  // Macro expansion and verification finish after the request that started them.
  onAsyncMacroExpansionComplete: () => post({ event: "analysisSettled" }),
};

const service = ts.createLanguageService(host);

async function loadPackageTypesIfImported() {
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
  const program = service.getProgram();
  const sourceFile = program?.getSourceFile(fileName);
  if (!program || !sourceFile) return undefined;
  const token = ts.getTokenAtPosition(sourceFile, offset);
  const checker = program.getTypeChecker();
  let typeNode: ts.TypeNode | undefined;
  if (ts.isIdentifier(token)) {
    const declaration = ts.isTypeAliasDeclaration(token.parent) && token.parent.name === token
      ? token.parent
      : checker.getSymbolAtLocation(token)?.declarations?.find(ts.isTypeAliasDeclaration);
    typeNode = declaration?.type;
  }
  if (!typeNode) {
    let candidate: ts.Node = token;
    while (candidate.parent && !ts.isTypeNode(candidate)) candidate = candidate.parent;
    if (ts.isTypeNode(candidate)) typeNode = candidate;
  }
  if (!typeNode) return undefined;
  const type = checker.getTypeAtLocation(typeNode);
  if (type.aliasSymbol?.declarations?.some(d => ts.isDataDeclaration(d) || ts.isNewtypeDeclaration(d))) return undefined;
  const normalized = checker.getNormalizedTypeAtLocation(typeNode)
    ?? checker.typeToString(type, typeNode, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias);
  const squash = (s: string) => s.replace(/\s+/g, " ").trim();
  if (squash(typeNode.getText(sourceFile)) === squash(normalized)) return undefined;
  const classification = checker.getTypeClassificationAtLocation(typeNode);
  return {
    text: squash(normalized),
    label: classification.label,
    classification: classification.text,
    span: { start: token.getStart(sourceFile), length: token.end - token.getStart(sourceFile) },
  };
}

function tagToString(tag: ts.JSDocTagInfo): string {
  const body = ts.displayPartsToString(tag.text);
  return `*@${tag.name}*${body ? ` — ${body}` : ""}`;
}

const api: WorkerApi = {
  init(z3) {
    solveVerificationQueries = createZ3Solver(z3, busy => post({ event: "solver", busy }));
    return { version: ts.version, features: ts.tsppFeatureDefinitions };
  },

  setProject(projectFiles, features) {
    for (const [fileName, text] of Object.entries(projectFiles)) {
      const file = files.get(fileName);
      if (file?.text !== text) files.set(fileName, { text, version: (file?.version ?? 0) + 1 });
    }
    for (const fileName of files.keys()) {
      if (!(fileName in projectFiles)) files.delete(fileName);
    }
    options = createOptions(features);
  },

  editFile(fileName, text) {
    const file = files.get(fileName);
    if (file && file.text !== text) files.set(fileName, { text, version: file.version + 1 });
  },

  diagnostics(fileName) {
    if (!isSourceFile(fileName)) return [];
    const diagnostics = [
      ...service.getCompilerOptionsDiagnostics(),
      ...service.getSyntacticDiagnostics(fileName),
      ...service.getSemanticDiagnostics(fileName),
    ];
    try {
      diagnostics.push(...service.getSuggestionDiagnostics(fileName));
    }
    catch {
      // Suggestions are optional; a failure there must not hide the errors above.
    }
    return diagnostics.map(toDiagnostic);
  },

  quickInfo(fileName, offset) {
    const info = service.getQuickInfoAtPosition(fileName, offset);
    const normalized = normalizedTypeAt(fileName, offset);
    const program = service.getProgram();
    const expansion = program?.getMacroExpansions?.(fileName).find(candidate => contains(candidate, offset));
    const artifact = program?.getVerificationArtifacts?.(fileName).find(candidate => contains(candidate, offset));
    const span = info?.textSpan ?? normalized?.span ?? expansion ?? artifact;
    if (!span) return undefined;
    return {
      span: { start: span.start, length: span.length },
      display: info && ts.displayPartsToString(info.displayParts),
      documentation: info && ts.displayPartsToString(info.documentation),
      tags: info?.tags?.map(tagToString) ?? [],
      normalized: normalized && { text: normalized.text, label: normalized.label, classification: normalized.classification },
      macroExpansion: expansion && { macroName: expansion.macroName, text: expansion.text },
      verification: artifact && { status: artifact.status, message: artifact.message, counterexample: artifact.counterexample },
    };
  },

  completions(fileName, offset, triggerCharacter) {
    const info = service.getCompletionsAtPosition(fileName, offset, {
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
    const details = service.getCompletionEntryDetails(fileName, offset, name, undefined, source, undefined, data as ts.CompletionEntryData | undefined);
    if (!details) return undefined;
    const documentation = [ts.displayPartsToString(details.documentation), ...details.tags?.map(tagToString) ?? []];
    return { display: ts.displayPartsToString(details.displayParts), documentation: documentation.filter(Boolean).join("\n\n") };
  },

  signatureHelp(fileName, offset, triggerCharacter, isRetrigger) {
    const triggerReason: ts.SignatureHelpTriggerReason = triggerCharacter
      ? { kind: isRetrigger ? "retrigger" : "characterTyped", triggerCharacter: triggerCharacter as ts.SignatureHelpTriggerCharacter }
      : { kind: "invoked" };
    const help = service.getSignatureHelpItems(fileName, offset, { triggerReason });
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
    return (service.getDefinitionAtPosition(fileName, offset) ?? [])
      .filter(definition => files.has(definition.fileName))
      .map((definition): Location => ({ fileName: definition.fileName, span: definition.textSpan }));
  },
};

async function handle({ id, method, args }: Request) {
  try {
    await loadPackageTypesIfImported();
    post({ id, result: (api[method] as (...a: unknown[]) => unknown)(...args) });
  }
  catch (error) {
    console.error(`[tspp worker] ${method} failed: ${error instanceof Error ? error.stack : error}`);
    post({ id, error: error instanceof Error ? error.message : String(error) });
  }
}

// Requests run strictly in arrival order, even when one waits for the package types.
let queue = Promise.resolve();
self.onmessage = (event: MessageEvent<Request>) => {
  queue = queue.then(() => handle(event.data));
};
