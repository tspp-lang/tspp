/// <reference lib="webworker" />
import * as ts from "ts-plus-plus/source";
import type { TSPPPlugin } from "@tspp/plugin-sdk";
import dependentTypes from "@tspp/plugin-dependent-types";
import higherKindedTypes from "@tspp/plugin-higher-kinded-types";
import modernSyntax from "@tspp/plugin-modern-syntax";
import nominalTypes from "@tspp/plugin-nominal-types";
import staticInterfaceMembers from "@tspp/plugin-static-interface-members";
import typeComputation from "@tspp/plugin-type-computation";
import libraries from "virtual:tspp-libs";
import type { WorkerRequest, WorkerResponse } from "./protocol";

const plugins: readonly TSPPPlugin[] = [
  modernSyntax,
  nominalTypes,
  typeComputation,
  higherKindedTypes,
  staticInterfaceMembers,
  dependentTypes,
];
const pluginById = new Map<string, TSPPPlugin>(plugins.map(plugin => [plugin.manifest.id, plugin]));
const fileName = "/index.tspp";
let initialized = false;

self.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === "initialize") {
      for (const id of data.features) {
        const plugin = pluginById.get(id);
        if (plugin) ts.registerTSPPCompilerPlugin(plugin);
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
  const projected = ts.getTSPPProjectedSource(fileName, source);
  const options: ts.CompilerOptions = {
    allowNonTsExtensions: true,
    module: ts.ModuleKind.ESNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
  };
  const host = ts.createCompilerHost(options);
  host.fileExists = path => path === fileName || readLibrary(path) !== undefined;
  host.readFile = path => path === fileName ? source : readLibrary(path);
  host.getSourceFile = (path, languageVersion) => {
    const text = host.readFile(path);
    return text === undefined ? undefined : ts.createSourceFile(path, text, languageVersion, true, ts.ScriptKind.TS);
  };
  host.getDefaultLibFileName = () => "/lib.es2022.full.d.ts";
  host.getCurrentDirectory = () => "/";
  host.writeFile = () => {};
  const program = ts.createProgram([fileName], options, host);
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
