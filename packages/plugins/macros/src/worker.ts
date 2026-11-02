import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import type { MacroCompilerHost, MacroInvocationEvents } from "./expand";

export interface SerializedMacroExpansion {
    readonly fileName: string;
    readonly start: number;
    readonly end: number;
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

export interface MacroWorkerData {
    readonly compilerPath: string;
    readonly pluginPath: string;
    readonly rootNames: readonly string[];
    readonly options: TS.CompilerOptions;
    readonly projectReferences: readonly TS.ProjectReference[] | undefined;
    readonly currentDirectory: string;
    readonly useCaseSensitiveFileNames: boolean;
    readonly snapshots: Readonly<Record<string, string>>;
    readonly macroTimeoutMs: number | undefined;
    readonly macroBenchmarkMs: number | undefined;
}

/** Expands the macros of a program in this thread and returns serializable results. */
export type InProcessExpansion = (
    program: TS.Program,
    host: MacroCompilerHost,
    events: MacroInvocationEvents,
) => Promise<MacroWorkerResult>;

type MacroWorkerMessage =
    | { readonly type: "macro-start"; readonly timeoutMs: number; readonly description: string; readonly fileName: string; readonly start: number; readonly length: number; readonly macroName: string; }
    | { readonly type: "macro-end"; }
    | { readonly type: "complete"; readonly value: MacroWorkerResult; }
    | { readonly type: "error"; readonly name: string; readonly message: string; readonly stack: string | undefined; };

const maxOldGenerationSizeMb = 256;
const startupTimeoutMs = 60_000;
const cancellationGraceMs = 100;
const maximumTimerDelayMs = 2_147_483_647;

/** A worker failure attributed to the invocation that was running, when there was one. */
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

// Bundlers rewrite literal `require` calls; Node.js modules are only reached through this alias, and only in Node.
const nodeRequire: NodeJS.Require | undefined = typeof require === "function" ? require : undefined;

export function canUseMacroWorkers(): boolean {
    try {
        return !!nodeRequire?.("node:worker_threads").Worker;
    }
    catch {
        return false;
    }
}

const queue: (() => void)[] = [];
let active = 0;
let maximum: number | undefined;

/** Expands a program's macros in a worker thread, which can be terminated when a synchronous macro never returns. */
export function runMacroExpansionWorker(
    program: TS.Program,
    compilerPath: string,
    host: MacroCompilerHost,
    getAuthoredText: (sourceFile: TS.SourceFile) => string,
): Promise<MacroWorkerResult> {
    return new Promise<MacroWorkerResult>((resolve, reject) => {
        queue.push(() => {
            active++;
            void startWorker(program, compilerPath, host, getAuthoredText).then(resolve, reject).finally(() => {
                active--;
                schedule();
            });
        });
        schedule();
    });
}

function schedule(): void {
    if (maximum === undefined) {
        const os = nodeRequire!("node:os") as typeof import("node:os");
        maximum = Math.max(1, Math.min(4, os.availableParallelism?.() ?? os.cpus().length));
    }
    while (active < maximum) {
        const start = queue.shift();
        if (!start) return;
        start();
    }
}

function startWorker(program: TS.Program, compilerPath: string, host: MacroCompilerHost, getAuthoredText: (sourceFile: TS.SourceFile) => string): Promise<MacroWorkerResult> {
    const path = nodeRequire!("node:path") as typeof import("node:path");
    const { Worker } = nodeRequire!("node:worker_threads") as typeof import("node:worker_threads");
    const currentDirectory = program.getCurrentDirectory();
    const useCaseSensitiveFileNames = host.useCaseSensitiveFileNames();
    const normalize = (fileName: string) => {
        const normalized = path.resolve(currentDirectory, fileName).replace(/\\/g, "/");
        return useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
    };
    const snapshots: Record<string, string> = {};
    // The worker parses the authored text again, so the snapshots must not be the projected text of this program.
    for (const sourceFile of program.getSourceFiles()) snapshots[normalize(sourceFile.fileName)] = getAuthoredText(sourceFile);
    const options = { ...program.getCompilerOptions() };
    delete options.configFile;
    const data: MacroWorkerData = {
        compilerPath,
        pluginPath: path.join(__dirname, "index.js"),
        rootNames: program.getRootFileNames(),
        options,
        projectReferences: program.getProjectReferences(),
        currentDirectory,
        useCaseSensitiveFileNames,
        snapshots,
        macroTimeoutMs: host.macroTimeoutMs,
        macroBenchmarkMs: host.macroBenchmarkMs,
    };

    return new Promise<MacroWorkerResult>((resolve, reject) => {
        const worker = new Worker(`require(${JSON.stringify(path.join(__dirname, "worker.js"))}).runInMacroWorker();`, {
            eval: true,
            workerData: data,
            resourceLimits: { maxOldGenerationSizeMb },
        });
        let settled = false;
        let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
        let activeMacro: Extract<MacroWorkerMessage, { readonly type: "macro-start"; }> | undefined;
        const activeMacroError = (message: string) =>
            new MacroWorkerError(message, activeMacro?.fileName, activeMacro?.start, activeMacro?.length, activeMacro?.macroName);
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
            timeout = globalThis.setTimeout(
                () => fail(activeMacroError(`${description} timed out after ${reportedTimeoutMs} ms.`)),
                Math.min(timeoutMs, maximumTimerDelayMs),
            );
        };

        armTimeout(startupTimeoutMs, "Macro worker startup");
        worker.on("message", (message: MacroWorkerMessage) => {
            switch (message.type) {
                case "macro-start":
                    activeMacro = message;
                    armTimeout(message.timeoutMs + cancellationGraceMs, `Macro execution (${message.description})`, message.timeoutMs);
                    break;
                case "macro-end":
                    activeMacro = undefined;
                    armTimeout(startupTimeoutMs, "Macro worker finalization");
                    break;
                case "complete":
                    if (settled) return;
                    settled = true;
                    cleanup();
                    void worker.terminate();
                    resolve(message.value);
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
                fail(activeMacroError(`Macro worker exceeded its ${maxOldGenerationSizeMb} MB old-generation memory limit.`), /*terminate*/ false);
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

/** The worker side: loads the compiler and this plugin, rebuilds the program from the snapshots, and expands it. */
export function runInMacroWorker(): void {
    const { parentPort, workerData } = nodeRequire!("node:worker_threads") as typeof import("node:worker_threads");
    if (!parentPort) throw new Error("The macro worker is missing its parent port.");
    const data = workerData as MacroWorkerData;
    const path = nodeRequire!("node:path") as typeof import("node:path");
    const run = async (): Promise<MacroWorkerResult> => {
        const ts = nodeRequire!(data.compilerPath) as TSPPTypeScript & { registerTSPPCompilerPlugin(plugin: unknown): boolean; };
        const plugin = nodeRequire!(data.pluginPath) as typeof import("./index");
        ts.registerTSPPCompilerPlugin(plugin.macrosPlugin);
        const normalize = (fileName: string) => {
            const normalized = path.resolve(data.currentDirectory, fileName).replace(/\\/g, "/");
            return data.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
        };
        const readSnapshot = (fileName: string) => data.snapshots[normalize(fileName)];
        const host = ts.createCompilerHost(data.options, /*setParentNodes*/ true) as MacroCompilerHost;
        const fileExists = host.fileExists.bind(host);
        const readFile = host.readFile.bind(host);
        const getSourceFile = host.getSourceFile.bind(host);
        host.getCurrentDirectory = () => data.currentDirectory;
        host.fileExists = fileName => readSnapshot(fileName) !== undefined || fileExists(fileName);
        host.readFile = fileName => readSnapshot(fileName) ?? readFile(fileName);
        host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
            const snapshot = readSnapshot(fileName);
            if (snapshot === undefined) return getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
            return ts.createSourceFile(fileName, snapshot, languageVersionOrOptions, /*setParentNodes*/ true, ts.ScriptKind.TS);
        };
        host.macroTimeoutMs = data.macroTimeoutMs;
        host.macroBenchmarkMs = data.macroBenchmarkMs;
        return plugin.expandInThisThread(ts, { rootNames: data.rootNames, options: data.options, host, projectReferences: data.projectReferences }, {
            onInvocationStart: info => parentPort.postMessage({ type: "macro-start", ...info }),
            onInvocationEnd: () => parentPort.postMessage({ type: "macro-end" }),
        });
    };
    run().then(
        value => parentPort.postMessage({ type: "complete", value }),
        thrown => {
            const error = thrown instanceof Error ? thrown : new Error(String(thrown));
            parentPort.postMessage({ type: "error", name: error.name, message: error.message, stack: error.stack });
        },
    );
}
