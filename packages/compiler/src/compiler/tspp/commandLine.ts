import type { TSPPPlugin } from "@tspp/plugin-sdk";

import {
    changeCompilerHostLikeToUseCache,
    combinePaths,
    createCompilerHostWorker,
    createDiagnosticReporter,
    createGetCanonicalFileName,
    createProgram,
    createSourceFile,
    Diagnostics,
    emitFilesAndReportErrorsAndGetExitStatus,
    executeCommandLine,
    getConfigFileParsingDiagnostics,
    getDiagnosticText,
    getDirectoryPath,
    getTsBuildInfoEmitOutputFilePath,
    isBuildCommand,
    noop,
    parseBuildCommand,
    parseCommandLine,
    toPath,
} from "../_namespaces/ts.js";
import type {
    BuilderProgram,
    BuildOptions,
    CompilerHost,
    CompilerOptions,
    CreateProgram,
    Diagnostic,
    DiagnosticReporter,
    ExecuteCommandLineCallbacks,
    ParsedCommandLine,
    Program,
    ReportEmitErrorSummary,
    SourceFile,
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
    getActiveTSPPPlugins,
    getOriginalTSPPSource,
    getTSPPPluginFromModule,
    registerTSPPCompilerPlugin,
    setActiveTSPPPlugins,
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

/** The feature plugins a tsconfig declares with `"tspp": true`; undefined after reporting a failure. */
function resolveTSPPConfiguredPlugins(options: CompilerOptions, configFileName: string, sys: System): readonly TSPPPlugin[] | undefined {
    const plugins = options.plugins?.filter(config => config.tspp);
    if (!plugins?.length) return [];
    if (!sys.require) {
        sys.write(`error TSPP1000: This host cannot load configured TSPP plugins.${sys.newLine}`);
        return undefined;
    }

    const nodeModules = combinePaths(getDirectoryPath(configFileName), "node_modules");
    const resolved: TSPPPlugin[] = [];
    for (const config of plugins) {
        const result = sys.require(nodeModules, config.name);
        if (result.error) {
            sys.write(`error TSPP1001: Cannot load plugin '${config.name}': ${result.error.message}${sys.newLine}`);
            return undefined;
        }
        const plugin = getTSPPPluginFromModule(result.module);
        if (!plugin) {
            sys.write(`error TSPP1002: Package '${config.name}' is not a TSPP feature plugin.${sys.newLine}`);
            return undefined;
        }
        resolved.push(plugin);
    }
    return resolved;
}

/** Loads the feature plugins a tsconfig declares; false after reporting a failure. @internal */
export function loadTSPPConfiguredPlugins(options: CompilerOptions, configFileName: string, sys: System): boolean {
    const plugins = resolveTSPPConfiguredPlugins(options, configFileName, sys);
    plugins?.forEach(registerTSPPCompilerPlugin);
    return !!plugins;
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
 * Incremental compilations, solution builds, and watch mode emit through upstream's builder programs, which
 * `performTSPPCompilation` never sees. Analyzers run on each builder's program instead: a one-shot run exits when they
 * finish, with their errors in its status, and watch mode reports them after each build, dropping results a newer build of
 * the project has replaced. A build info file records no analyzer errors, so a project that has some loses its file, or
 * the next solution build would call the project up to date.
 */
function analyzeBuilderPrograms(system: System, cb: ExecuteCommandLineCallbacks, options: { readonly pretty?: boolean; readonly watch?: boolean; }): { system: System; cb: ExecuteCommandLineCallbacks; pending(): Promise<void> | undefined; } {
    const reportDiagnostic = createDiagnosticReporter(system, options.pretty ?? !!system.writeOutputIsTTY?.());
    const programs: { readonly program: Program; readonly plugins: readonly TSPPPlugin[]; }[] = [];
    const builds = new Map<string | undefined, number>();
    let pending: Promise<void> | undefined;
    const analyze = async (program: Program, isCurrent: () => boolean = () => true) => {
        const diagnostics = (await runTSPPProgramAnalyzers(program)).map(diagnostic => toTSPPAnalysisDiagnostic(program, diagnostic));
        if (!isCurrent()) return false;
        diagnostics.forEach(reportDiagnostic);
        const failed = diagnostics.some(diagnostic => diagnostic.category === DiagnosticCategory.Error);
        const buildInfo = failed ? getTsBuildInfoEmitOutputFilePath(program.getCompilerOptions()) : undefined;
        if (buildInfo && system.fileExists(buildInfo)) system.deleteFile?.(buildInfo);
        return failed;
    };
    const analyzedSystem: System = Object.create(system);
    analyzedSystem.exit = exitCode => {
        if (!programs.length) return system.exit(exitCode);
        pending = (async () => {
            let failed = false;
            // A solution build has moved on to other projects by now, and an analyzer parses with its project's plugins.
            for (const { program, plugins } of programs) {
                setActiveTSPPPlugins(plugins);
                failed = await analyze(program) || failed;
            }
            const failedStatus = programs[0].program.getCompilerOptions().noEmit ? ExitStatus.DiagnosticsPresent_OutputsSkipped : ExitStatus.DiagnosticsPresent_OutputsGenerated;
            system.exit(exitCode || (failed ? failedStatus : ExitStatus.Success));
        })();
    };
    return {
        system: analyzedSystem,
        cb: programOrConfig => {
            const built = (programOrConfig as { getProgram?(): Program; }).getProgram?.();
            if (built && hasTSPPProgramAnalyzers()) {
                if (options.watch) {
                    const project = built.getCompilerOptions().configFilePath;
                    const current = (builds.get(project) ?? 0) + 1;
                    builds.set(project, current);
                    pending = analyze(built, () => builds.get(project) === current).then(noop);
                }
                else {
                    programs.push({ program: built, plugins: getActiveTSPPPlugins() });
                }
            }
            cb(programOrConfig);
        },
        pending: () => pending,
    };
}

/**
 * Solution builds read each project's configuration inside the builder, so a project's plugins become the active ones when
 * its program is created, and it checks and emits before the builder creates the next program (docs/plugin-framework.md).
 * @internal
 */
export function enableTSPPBuildPlugins<T extends BuilderProgram>(sys: System, host: { createProgram: CreateProgram<T>; }): void {
    const createBuilderProgram = host.createProgram;
    const parsedWith = new WeakMap<SourceFile, readonly TSPPPlugin[]>();
    host.createProgram = (rootNames, options, compilerHost, ...rest) => {
        const configFileName = options?.configFilePath;
        if (options && configFileName) {
            const plugins = resolveTSPPConfiguredPlugins(options, configFileName, sys);
            if (plugins) setActiveTSPPPlugins(plugins);
            else sys.exit(ExitStatus.DiagnosticsPresent_OutputsSkipped);
        }
        return createBuilderProgram(rootNames, options, compilerHost && parseTSPPDeclarationsPerPluginSet(compilerHost, parsedWith), ...rest);
    };
}

/**
 * The builder shares parsed declaration files between projects, but a `.d.tspp` file means what the active plugins read
 * in it. A project whose plugins differ from those that parsed the shared file parses its own copy.
 */
function parseTSPPDeclarationsPerPluginSet(host: CompilerHost, parsedWith: WeakMap<SourceFile, readonly TSPPPlugin[]>): CompilerHost {
    const plugins = getActiveTSPPPlugins();
    const perSet: CompilerHost = Object.create(host);
    perSet.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const shared = host.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
        if (!shared || !fileName.endsWith(".d.tspp")) return shared;
        const parsedBy = parsedWith.get(shared);
        if (!parsedBy) parsedWith.set(shared, plugins);
        if (!parsedBy || parsedBy.length === plugins.length && parsedBy.every(plugin => plugins.includes(plugin))) return shared;
        const own = createSourceFile(fileName, getOriginalTSPPSource(fileName, shared.text), languageVersionOrOptions);
        own.version = shared.version;
        return own;
    };
    return perSet;
}

/**
 * Runs the `tspp` command line. One-shot compilations wait for asynchronous program rebuilders such as compile-time
 * macros and for analyzers; incremental compilations, solution builds, and watch mode keep upstream's synchronous builders,
 * whose long-lived state needs a separate asynchronous design, and run analyzers on what they build.
 * @internal
 */
export function executeTSPPCommandLine(system: System, cb: ExecuteCommandLineCallbacks, commandLineArgs: readonly string[]): void {
    Promise.resolve(executeCommandLineAsync(system, cb, commandLineArgs)).catch(error => {
        system.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}${system.newLine}`);
        system.exit?.(ExitStatus.DiagnosticsPresent_OutputsSkipped);
    });
}

function executeCommandLineAsync(system: System, cb: ExecuteCommandLineCallbacks, commandLineArgs: readonly string[]): unknown {
    if (isBuildCommand(commandLineArgs)) {
        const builders = analyzeBuilderPrograms(system, cb, parseBuildCommand(commandLineArgs).buildOptions);
        const result = executeCommandLine(builders.system, builders.cb, commandLineArgs);
        return builders.pending() ?? result;
    }
    const commandLine = parseCommandLine(commandLineArgs, path => system.readFile(path));
    const builders = analyzeBuilderPrograms(system, cb, commandLine.options);
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
