/// <reference lib="webworker" />
import * as ts from "ts-plus-plus/source";
import type { TSPPPlugin } from "@tspp/plugin-sdk";
import dependentTypesModule from "@tspp/plugin-dependent-types";
import * as formalVerificationNamespace from "@tspp/plugin-formal-verification";
import higherKindedTypesModule from "@tspp/plugin-higher-kinded-types";
import macrosModule from "@tspp/plugin-macros";
import modernSyntaxModule from "@tspp/plugin-modern-syntax";
import nominalTypesModule from "@tspp/plugin-nominal-types";
import staticInterfaceMembersModule from "@tspp/plugin-static-interface-members";
import typeComputationModule from "@tspp/plugin-type-computation";
import libraries from "virtual:tspp-libs";
import type { WorkerRequest, WorkerResponse } from "./protocol";
import { createBrowserZ3Solver } from "./z3Bridge";

const plugins: readonly TSPPPlugin[] = [
  pluginDefault(modernSyntaxModule),
  pluginDefault(nominalTypesModule),
  pluginDefault(typeComputationModule),
  pluginDefault(higherKindedTypesModule),
  pluginDefault(staticInterfaceMembersModule),
  pluginDefault(dependentTypesModule),
  formalVerificationExports(formalVerificationNamespace).formalVerificationPlugin,
  pluginDefault(macrosModule),
];
const pluginById = new Map<string, TSPPPlugin>(plugins.map(plugin => [plugin.manifest.id, plugin]));
const fileName = "/index.tspp";
let initialized = false;

formalVerificationExports(formalVerificationNamespace).configureZ3Solver(createBrowserZ3Solver({
  workerUrl: new URL("../z3/z3.worker.js", self.location.href).href,
  wasmUrl: new URL("../z3/z3-built.wasm", self.location.href).href,
}));

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === "initialize") {
      for (const id of data.features) {
        const plugin = pluginById.get(id);
        if (plugin) {
          try { ts.registerTSPPCompilerPlugin(plugin); }
          catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to activate '${id}': ${message}`, { cause: error });
          }
        }
      }
      initialized = true;
      post({ type: "ready" });
      return;
    }
    if (!initialized) throw new Error("The playground worker is not initialized.");
    post({ type: "result", result: await check(data.source) });
  }
  catch (error) {
    post({ type: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
};

async function check(source: string): Promise<{ projected: string; diagnostics: readonly string[] }> {
  const options: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const readFile = (path: string): string | undefined => path === fileName ? source : readLibrary(path);
  const host: ts.CompilerHost = {
    fileExists: path => readFile(path) !== undefined,
    readFile,
    getSourceFile(path, languageVersion) {
      const text = readFile(path);
      return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true, ts.ScriptKind.TS);
    },
    getDefaultLibFileName: () => "/lib.es2022.full.d.ts",
    getCurrentDirectory: () => "/",
    getCanonicalFileName: path => path,
    getNewLine: () => "\n",
    useCaseSensitiveFileNames: () => true,
    writeFile: () => {},
  };
  host.disableMacroWorkers = true;
  host.evaluateMacroModule = evaluateMacroModule;
  host.resolveMacroModule = resolveMacroModule;
  const program = await ts.createProgramAsync({ rootNames: [fileName], options, host });
  const expandedSource = applyMacroExpansions(source, program.getMacroExpansions?.(fileName) ?? []);
  const projected = ts.getTSPPProjectedSource(fileName, expandedSource);
  const standard = ts.getPreEmitDiagnostics(program);
  const analysis = ts.hasTSPPProgramAnalyzers() ? await ts.runTSPPProgramAnalyzers(program) : [];
  return {
    projected,
    diagnostics: [
      ...standard.map(diagnostic => formatDiagnostic(diagnostic)),
      ...analysis.map(diagnostic => `${diagnostic.fileName}:${diagnostic.start} TS${diagnostic.code}: ${diagnostic.message}`),
    ],
  };
}

function applyMacroExpansions(source: string, expansions: readonly ts.MacroExpansion[]): string {
  return [...expansions]
    .sort((left, right) => right.start - left.start)
    .reduce((text, expansion) =>
      text.slice(0, expansion.start) + expansion.text + text.slice(expansion.start + expansion.length), source);
}

function evaluateMacroModule(
  javascript: string,
  moduleFileName: string,
  requireLocal: (specifier: string) => unknown,
  module: { exports: Record<string, unknown> },
): void {
  const require = (specifier: string): unknown => {
    const local = requireLocal(specifier);
    if (local !== undefined) return local;
    throw new Error(`Cannot find macro module '${specifier}' in the single-file playground.`);
  };
  const directory = moduleFileName.slice(0, moduleFileName.lastIndexOf("/")) || "/";
  const execute = new Function("require", "exports", "module", "__filename", "__dirname", javascript);
  execute(require, module.exports, module, moduleFileName, directory);
}

function resolveMacroModule(): undefined {
  return undefined;
}

function readLibrary(path: string): string | undefined {
  return libraries[path.slice(path.lastIndexOf("/") + 1)];
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) return `TS${diagnostic.code}: ${message}`;
  const position = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  return `${diagnostic.file.fileName}:${position.line + 1}:${position.character + 1} TS${diagnostic.code}: ${message}`;
}

function post(response: WorkerResponse): void {
  self.postMessage(response);
}

function pluginDefault(value: TSPPPlugin | { readonly default: TSPPPlugin }): TSPPPlugin {
  return "default" in value ? value.default : value;
}

function formalVerificationExports(value: typeof formalVerificationNamespace): {
  readonly formalVerificationPlugin: TSPPPlugin;
  readonly configureZ3Solver: typeof import("@tspp/plugin-formal-verification").configureZ3Solver;
} {
  const exports = "configureZ3Solver" in value ? value : value.default as unknown;
  return exports as {
    readonly formalVerificationPlugin: TSPPPlugin;
    readonly configureZ3Solver: typeof import("@tspp/plugin-formal-verification").configureZ3Solver;
  };
}
