import {
    CompilerOptions,
    Program,
    ProjectReference,
} from "./types.js";

export interface SerializedMacroExpansion {
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly macroName: string;
    readonly text: string;
}

export interface SerializedMacroDiagnostic {
    readonly fileName: string | undefined;
    readonly start: number | undefined;
    readonly length: number | undefined;
    readonly code: number;
    readonly category: number;
    readonly messageText: string;
}

export interface MacroWorkerResult {
    readonly expansions: readonly SerializedMacroExpansion[];
    readonly diagnostics: readonly SerializedMacroDiagnostic[];
}

interface MacroWorkerOptions {
    readonly maxOldGenerationSizeMb?: number;
    readonly startupTimeoutMs?: number;
    readonly cancellationGraceMs?: number;
}

interface MacroWorkerRequest {
    readonly compilerPath: string;
    readonly rootNames: readonly string[];
    readonly options: CompilerOptions;
    readonly projectReferences: readonly ProjectReference[] | undefined;
    readonly currentDirectory: string;
    readonly useCaseSensitiveFileNames: boolean;
    readonly snapshots: Readonly<Record<string, string>>;
    readonly macroTimeoutMs: number | undefined;
    readonly macroBenchmarkMs: number | undefined;
}

type MacroWorkerMessage =
    | { readonly type: "macro-start"; readonly timeoutMs: number; readonly description: string; readonly fileName: string; readonly start: number; readonly length: number; readonly macroName: string; }
    | { readonly type: "macro-end"; }
    | { readonly type: "complete"; readonly value: MacroWorkerResult; }
    | { readonly type: "error"; readonly name: string; readonly message: string; readonly stack: string | undefined; };

const defaultMacroWorkerOptions: Required<MacroWorkerOptions> = {
    maxOldGenerationSizeMb: 256,
    startupTimeoutMs: 60_000,
    cancellationGraceMs: 100,
};
const maximumTimerDelayMs = 2_147_483_647;

export class MacroWorkerError extends Error {
    public constructor(
        message: string,
        readonly fileName?: string,
        readonly start?: number,
        readonly length?: number,
        readonly macroName?: string,
    ) {
        super(message);
        this.name = "MacroWorkerError";
    }
}

const macroWorkerScript = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const path = require("node:path");

if (parentPort === null) throw new Error("The macro worker is missing its parent port.");

function normalizeFileName(fileName) {
  const normalized = path.resolve(workerData.currentDirectory, fileName).replaceAll("\\", "/");
  return workerData.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
}

async function run() {
  const ts = require(workerData.compilerPath);
  ts.registerTSPPCompilerPlugin({
    manifest: { id: "macros", version: "0.0.1", apiVersion: 2 },
    facets: { compiler: { activate: context => context.compiler.registerCompileTimeMacros() } },
  });
  const host = ts.createCompilerHost(workerData.options, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const readSnapshot = fileName => workerData.snapshots[normalizeFileName(fileName)];

  host.getCurrentDirectory = () => workerData.currentDirectory;
  host.fileExists = fileName => readSnapshot(fileName) !== undefined || originalFileExists(fileName);
  host.readFile = fileName => readSnapshot(fileName) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const snapshot = readSnapshot(fileName);
    if (snapshot === undefined) {
      return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    }
    return ts.createSourceFile(
      fileName,
      snapshot,
      languageVersionOrOptions,
      true,
      ts.getScriptKindFromFileName(fileName),
    );
  };
  host.disableMacroWorkers = true;
  host.macroTimeoutMs = workerData.macroTimeoutMs;
  host.macroBenchmarkMs = workerData.macroBenchmarkMs;
  host.onMacroInvocationStart = info => parentPort.postMessage({ type: "macro-start", ...info });
  host.onMacroInvocationEnd = () => parentPort.postMessage({ type: "macro-end" });

  const program = await ts.createProgramAsync({
    rootNames: workerData.rootNames,
    options: workerData.options,
    host,
    projectReferences: workerData.projectReferences,
  });
  const expansions = program.getMacroExpansions?.() ?? [];
  const diagnostics = program.getSemanticDiagnostics()
    .filter(diagnostic => diagnostic.code >= 18080 && diagnostic.code <= 18082)
    .map(diagnostic => ({
      fileName: diagnostic.file?.fileName,
      start: diagnostic.start,
      length: diagnostic.length,
      code: diagnostic.code,
      category: diagnostic.category,
      messageText: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    }));
  return { expansions, diagnostics };
}

run().then(
  value => parentPort.postMessage({ type: "complete", value }),
  thrown => {
    const error = thrown instanceof Error ? thrown : new Error(String(thrown));
    parentPort.postMessage({ type: "error", name: error.name, message: error.message, stack: error.stack });
  },
);
`;

export function canUseMacroWorkers(): boolean {
    try {
        return typeof require === "function" && !!require("node:worker_threads").Worker;
    }
    catch {
        return false;
    }
}

interface QueuedMacroWorkerTask {
    start(): void;
}

const macroWorkerQueue: QueuedMacroWorkerTask[] = [];
let activeMacroWorkerCount = 0;
let maximumMacroWorkerCount: number | undefined;

export function runMacroExpansionWorker(
    program: Program,
    compilerOptions: CompilerOptions,
    projectReferences: readonly ProjectReference[] | undefined,
    macroTimeoutMs: number | undefined,
    macroBenchmarkMs: number | undefined,
    options: MacroWorkerOptions = {},
): Promise<MacroWorkerResult> {
    return new Promise<MacroWorkerResult>((resolve, reject) => {
        macroWorkerQueue.push({
            start: () => {
                activeMacroWorkerCount++;
                void startMacroExpansionWorker(program, compilerOptions, projectReferences, macroTimeoutMs, macroBenchmarkMs, options)
                    .then(resolve, reject)
                    .finally(() => {
                        activeMacroWorkerCount--;
                        scheduleMacroWorkers();
                    });
            },
        });
        scheduleMacroWorkers();
    });
}

function scheduleMacroWorkers(): void {
    if (maximumMacroWorkerCount === undefined) {
        const os = require("node:os") as typeof import("node:os");
        const availableParallelism = os.availableParallelism?.() ?? os.cpus().length;
        maximumMacroWorkerCount = Math.max(1, Math.min(4, availableParallelism));
    }
    while (activeMacroWorkerCount < maximumMacroWorkerCount) {
        const task = macroWorkerQueue.shift();
        if (!task) return;
        task.start();
    }
}

function startMacroExpansionWorker(
    program: Program,
    compilerOptions: CompilerOptions,
    projectReferences: readonly ProjectReference[] | undefined,
    macroTimeoutMs: number | undefined,
    macroBenchmarkMs: number | undefined,
    options: MacroWorkerOptions,
): Promise<MacroWorkerResult> {
    const normalizedOptions = { ...defaultMacroWorkerOptions, ...options };
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const { Worker } = require("node:worker_threads") as typeof import("node:worker_threads");
    const siblingCompilerPath = path.join(path.dirname(__filename), "typescript.js");
    const compilerPath = fs.existsSync(siblingCompilerPath) ? siblingCompilerPath : __filename;
    const currentDirectory = program.getCurrentDirectory();
    const useCaseSensitiveFileNames = program.useCaseSensitiveFileNames();
    const normalizeFileName = (fileName: string) => {
        const normalized = path.resolve(currentDirectory, fileName).replace(/\\/g, "/");
        return useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
    };
    const snapshots: Record<string, string> = {};
    for (const sourceFile of program.getSourceFiles()) snapshots[normalizeFileName(sourceFile.fileName)] = sourceFile.text;

    const request: MacroWorkerRequest = {
        compilerPath,
        rootNames: program.getRootFileNames(),
        options: cloneCompilerOptions(compilerOptions),
        projectReferences,
        currentDirectory,
        useCaseSensitiveFileNames,
        snapshots,
        macroTimeoutMs,
        macroBenchmarkMs,
    };

    return new Promise<MacroWorkerResult>((resolve, reject) => {
        const worker = new Worker(macroWorkerScript, {
            eval: true,
            workerData: request,
            resourceLimits: { maxOldGenerationSizeMb: normalizedOptions.maxOldGenerationSizeMb },
        });
        let settled = false;
        let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
        let activeMacro: Extract<MacroWorkerMessage, { readonly type: "macro-start"; }> | undefined;

        const cleanup = () => {
            if (timeout !== undefined) globalThis.clearTimeout(timeout);
            worker.removeAllListeners();
        };
        const fail = (error: Error, terminate = true) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (terminate) void worker.terminate();
            reject(error);
        };
        const armTimeout = (timeoutMs: number, description: string, reportedTimeoutMs = timeoutMs) => {
            if (timeout !== undefined) globalThis.clearTimeout(timeout);
            timeout = globalThis.setTimeout(() =>
                fail(
                    new MacroWorkerError(
                        `${description} timed out after ${reportedTimeoutMs} ms.`,
                        activeMacro?.fileName,
                        activeMacro?.start,
                        activeMacro?.length,
                        activeMacro?.macroName,
                    ),
                ), Math.min(timeoutMs, maximumTimerDelayMs));
        };
        const succeed = (value: MacroWorkerResult) => {
            if (settled) return;
            settled = true;
            cleanup();
            void worker.terminate();
            resolve(value);
        };
        const activeMacroError = (message: string) =>
            new MacroWorkerError(
                message,
                activeMacro?.fileName,
                activeMacro?.start,
                activeMacro?.length,
                activeMacro?.macroName,
            );

        armTimeout(normalizedOptions.startupTimeoutMs, "Macro worker startup");
        worker.on("message", (message: MacroWorkerMessage) => {
            switch (message.type) {
                case "macro-start":
                    activeMacro = message;
                    armTimeout(
                        message.timeoutMs + normalizedOptions.cancellationGraceMs,
                        `Macro execution (${message.description})`,
                        message.timeoutMs,
                    );
                    break;
                case "macro-end":
                    activeMacro = undefined;
                    armTimeout(normalizedOptions.startupTimeoutMs, "Macro worker finalization");
                    break;
                case "complete":
                    succeed(message.value);
                    break;
                case "error": {
                    const error = new Error(message.message);
                    error.name = message.name;
                    if (message.stack !== undefined) error.stack = message.stack;
                    fail(error);
                    break;
                }
            }
        });
        worker.on("error", error => {
            if ((error as NodeJS.ErrnoException).code === "ERR_WORKER_OUT_OF_MEMORY") {
                fail(
                    activeMacroError(`Macro worker exceeded its ${normalizedOptions.maxOldGenerationSizeMb} MB old-generation memory limit.`),
                    /*terminate*/ false,
                );
            }
            else {
                const message = error instanceof Error ? error.message : String(error);
                fail(activeMacro === undefined ? new Error(message) : activeMacroError(message), /*terminate*/ false);
            }
        });
        worker.on("exit", exitCode => {
            if (!settled) {
                const message = `Macro worker exited before returning a result (exit code ${exitCode}).`;
                fail(activeMacro === undefined ? new Error(message) : activeMacroError(message), /*terminate*/ false);
            }
        });
    });
}

function cloneCompilerOptions(options: CompilerOptions): CompilerOptions {
    const clone = { ...options };
    delete clone.configFile;
    return clone;
}
