import {
    changeCompilerHostLikeToUseCache,
    combinePaths,
    createCompilerHostWorker,
    createDiagnosticReporter,
    createGetCanonicalFileName,
    createProgram,
    Diagnostics,
    emitFilesAndReportErrorsAndGetExitStatus,
    executeCommandLine,
    getConfigFileParsingDiagnostics,
    getDiagnosticText,
    getDirectoryPath,
    isBuildCommand,
    parseCommandLine,
    toPath,
} from "../_namespaces/ts.js";
import type {
    BuildOptions,
    CompilerOptions,
    Diagnostic,
    DiagnosticReporter,
    ExecuteCommandLineCallbacks,
    ParsedCommandLine,
    Program,
    ReportEmitErrorSummary,
    System,
} from "../_namespaces/ts.js";
import {
    DiagnosticCategory,
    ExitStatus,
    JSDocParsingMode,
} from "../types.js";
import {
    hasTSPPProgramAnalyzers,
    runTSPPProgramAnalyzers,
    toTSPPAnalysisDiagnostic,
} from "./analysis.js";
import { createProgramAsync } from "./rebuild.js";
import {
    getTSPPPluginFromModule,
    registerTSPPCompilerPlugin,
} from "./registry.js";

// The `tspp` command line: product branding, plugins loaded from tsconfig, and one-shot compilations that wait for
// program rebuilders and analyzers. The upstream command line calls in at `TSPP-SLOT(command-line)` sites.

/** Help headers name the TS++ compiler instead of tsc. @internal */
export function getTSPPHelpHeader(message: string): string {
    return message.replace(getDiagnosticText(Diagnostics.tsc_Colon_The_TypeScript_Compiler), "TS++ Compiler");
}

/** The text of the help icon. @internal */
export const tsppHelpIcon = "TS++ ";

/** Help examples invoke `tspp`. @internal */
export function getTSPPHelpExample(example: string): string {
    return example.replace(/^tsc\b/, "tspp");
}

/** Help prose refers to `tspp`; links such as `aka.ms/tsc-composite-builds` keep their spelling. @internal */
export function getTSPPHelpText(text: string): string {
    return text.replace(/\btsc\b(?!-)/g, "tspp");
}

/** Loads the feature plugins a tsconfig declares with `"tspp": true`; false after reporting a failure. @internal */
export function loadTSPPConfiguredPlugins(options: CompilerOptions, configFileName: string, sys: System): boolean {
    const plugins = options.plugins?.filter(config => config.tspp);
    if (!plugins?.length) return true;
    if (!sys.require) {
        sys.write(`error TSPP1000: This host cannot load configured TSPP plugins.${sys.newLine}`);
        return false;
    }

    const nodeModules = combinePaths(getDirectoryPath(configFileName), "node_modules");
    for (const config of plugins) {
        const result = sys.require(nodeModules, config.name);
        if (result.error) {
            sys.write(`error TSPP1001: Cannot load plugin '${config.name}': ${result.error.message}${sys.newLine}`);
            return false;
        }
        const plugin = getTSPPPluginFromModule(result.module);
        if (!plugin) {
            sys.write(`error TSPP1002: Package '${config.name}' is not a TSPP feature plugin.${sys.newLine}`);
            return false;
        }
        registerTSPPCompilerPlugin(plugin);
    }
    return true;
}

/** Functions of the upstream command line that a TS++ compilation reuses. @internal */
export interface TSPPCommandLineInternals {
    enableStatisticsAndTracing(system: System, compilerOptions: CompilerOptions, isBuildMode: boolean): void;
    reportStatistics(sys: System, program: Program, solutionPerformance: undefined): void;
    createReportErrorSummary(sys: System, options: CompilerOptions | BuildOptions): ReportEmitErrorSummary | undefined;
}

/** Set while `executeTSPPCommandLine` runs a one-shot compilation, which then waits for asynchronous program rebuilders. */
let asyncCompilation = false;
let pendingCompilation: Promise<void> | undefined;

/** Whether a one-shot compilation must take the TS++ path: it is asynchronous, or program analyzers are active. @internal */
export function isTSPPCompilation(): boolean {
    return asyncCompilation || hasTSPPProgramAnalyzers();
}

/**
 * The upstream one-shot compilation with two additions: the program comes from `createProgramAsync` when asynchronous,
 * and analyzer diagnostics are reported before emit and fail the exit status.
 * @internal
 */
export function performTSPPCompilation(
    sys: System,
    cb: ExecuteCommandLineCallbacks,
    reportDiagnostic: DiagnosticReporter,
    config: ParsedCommandLine,
    internals: TSPPCommandLineInternals,
): void {
    const { fileNames, options, projectReferences } = config;
    const host = createCompilerHostWorker(options, /*setParentNodes*/ undefined, sys);
    // The command line's default.
    host.jsDocParsingMode = JSDocParsingMode.ParseForTypeErrors;
    const currentDirectory = host.getCurrentDirectory();
    const getCanonicalFileName = createGetCanonicalFileName(host.useCaseSensitiveFileNames());
    changeCompilerHostLikeToUseCache(host, fileName => toPath(fileName, currentDirectory, getCanonicalFileName));
    internals.enableStatisticsAndTracing(sys, options, /*isBuildMode*/ false);

    const programOptions = {
        rootNames: fileNames,
        options,
        projectReferences,
        host,
        configFileParsingDiagnostics: getConfigFileParsingDiagnostics(config),
    };
    const finish = (program: Program, analysisDiagnostics: readonly Diagnostic[]) => {
        for (const diagnostic of analysisDiagnostics) reportDiagnostic(diagnostic);
        let exitStatus = emitFilesAndReportErrorsAndGetExitStatus(
            program,
            reportDiagnostic,
            s => sys.write(s + sys.newLine),
            internals.createReportErrorSummary(sys, options),
        );
        if (analysisDiagnostics.some(diagnostic => diagnostic.category === DiagnosticCategory.Error)) {
            exitStatus = options.noEmit ? ExitStatus.DiagnosticsPresent_OutputsSkipped : ExitStatus.DiagnosticsPresent_OutputsGenerated;
        }
        internals.reportStatistics(sys, program, /*solutionPerformance*/ undefined);
        cb(program);
        return sys.exit(exitStatus);
    };
    const analyze = async (program: Program) => hasTSPPProgramAnalyzers() ? (await runTSPPProgramAnalyzers(program)).map(diagnostic => toTSPPAnalysisDiagnostic(program, diagnostic)) : [];

    if (asyncCompilation) {
        pendingCompilation = (async () => {
            const program = await createProgramAsync(programOptions);
            finish(program, await analyze(program));
        })();
        return;
    }
    const program = createProgram(programOptions);
    void analyze(program).then(
        diagnostics => finish(program, diagnostics),
        error => {
            sys.write(`error TSPP1003: Program analysis failed: ${error instanceof Error ? error.message : String(error)}${sys.newLine}`);
            return sys.exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
        },
    );
}

/**
 * Incremental compilations and watch mode emit through upstream's builder programs, which `performTSPPCompilation` never
 * sees. Analyzers run on each builder's program instead: a one-shot compilation exits when they finish, with their errors
 * in its status, and watch mode reports them after each build, dropping results a newer build has replaced.
 */
function analyzeBuilderPrograms(system: System, cb: ExecuteCommandLineCallbacks, commandLine: ParsedCommandLine): { system: System; cb: ExecuteCommandLineCallbacks; pending(): Promise<void> | undefined; } {
    const reportDiagnostic = createDiagnosticReporter(system, commandLine.options.pretty ?? !!system.writeOutputIsTTY?.());
    let program: Program | undefined;
    let pending: Promise<void> | undefined;
    let build = 0;
    const analyze = async (target: Program) => hasTSPPProgramAnalyzers() ? (await runTSPPProgramAnalyzers(target)).map(diagnostic => toTSPPAnalysisDiagnostic(target, diagnostic)) : [];
    const analyzedSystem: System = Object.create(system);
    analyzedSystem.exit = exitCode => {
        if (!program || !hasTSPPProgramAnalyzers()) return system.exit(exitCode);
        pending = analyze(program).then(diagnostics => {
            for (const diagnostic of diagnostics) reportDiagnostic(diagnostic);
            const failedStatus = commandLine.options.noEmit ? ExitStatus.DiagnosticsPresent_OutputsSkipped : ExitStatus.DiagnosticsPresent_OutputsGenerated;
            system.exit(exitCode || (diagnostics.some(diagnostic => diagnostic.category === DiagnosticCategory.Error) ? failedStatus : ExitStatus.Success));
        });
    };
    return {
        system: analyzedSystem,
        cb: programOrConfig => {
            const built = (programOrConfig as { getProgram?(): Program; }).getProgram?.();
            if (built) {
                program = built;
                if (commandLine.options.watch && hasTSPPProgramAnalyzers()) {
                    const current = ++build;
                    pending = analyze(built).then(diagnostics => {
                        if (current === build) diagnostics.forEach(reportDiagnostic);
                    });
                }
            }
            cb(programOrConfig);
        },
        pending: () => pending,
    };
}

/**
 * Runs the `tspp` command line. One-shot compilations wait for asynchronous program rebuilders such as compile-time
 * macros and for analyzers; incremental and watch compilations keep upstream's synchronous builders, whose long-lived
 * state needs a separate asynchronous design, and run analyzers on what they build. Solution builds do not load plugins:
 * a project needs `tspp -p` for them.
 * @internal
 */
export function executeTSPPCommandLine(system: System, cb: ExecuteCommandLineCallbacks, commandLineArgs: readonly string[]): void {
    Promise.resolve(executeCommandLineAsync(system, cb, commandLineArgs)).catch(error => {
        system.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}${system.newLine}`);
        system.exit?.(ExitStatus.DiagnosticsPresent_OutputsSkipped);
    });
}

function executeCommandLineAsync(system: System, cb: ExecuteCommandLineCallbacks, commandLineArgs: readonly string[]): unknown {
    if (isBuildCommand(commandLineArgs)) return executeCommandLine(system, cb, commandLineArgs);
    const commandLine = parseCommandLine(commandLineArgs, path => system.readFile(path));
    const builders = analyzeBuilderPrograms(system, cb, commandLine);
    if (commandLine.options.generateCpuProfile && system.enableCPUProfiler) {
        const result = executeCommandLine(builders.system, builders.cb, commandLineArgs);
        return builders.pending() ?? result;
    }
    asyncCompilation = true;
    pendingCompilation = undefined;
    try {
        const result = executeCommandLine(builders.system, builders.cb, commandLineArgs);
        return pendingCompilation ?? builders.pending() ?? result;
    }
    finally {
        asyncCompilation = false;
        pendingCompilation = undefined;
    }
}
