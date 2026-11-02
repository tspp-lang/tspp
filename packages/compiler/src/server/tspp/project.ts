import {
    emptyArray,
    getTSPPPluginFromModule,
    hasTSPPProgramAnalyzers,
    registerTSPPCompilerPlugin,
    runTSPPProgramAnalyzers,
    toTSPPAnalysisDiagnostic,
} from "../_namespaces/ts.js";
import type {
    Diagnostic,
    LanguageService,
    PluginImport,
    Program,
} from "../_namespaces/ts.js";
import type {
    PluginModuleFactory,
    PluginModuleWithName,
    Project,
} from "../_namespaces/ts.server.js";

const projectsWithAnalysis = new WeakSet<Project>();

/**
 * Activates a TS++ feature plugin that a project's tsconfig names (`TSPP-SLOT(plugin-host)`), instead of enabling it as
 * a language service plugin. The first one also makes the project's semantic diagnostics include program analyzer
 * diagnostics: analysis runs in the background per program and refreshes the diagnostics when it settles. Returns
 * false for ordinary language service plugins. `setLanguageService` replaces the project's language service.
 * @internal
 */
export function enableTSPPPlugin(
    project: Project,
    pluginModuleFactory: PluginModuleFactory,
    configEntry: PluginImport,
    plugins: PluginModuleWithName[],
    setLanguageService: (languageService: LanguageService) => void,
): boolean {
    const tsppPlugin = getTSPPPluginFromModule(pluginModuleFactory);
    if (!tsppPlugin) return false;
    registerTSPPCompilerPlugin(tsppPlugin);
    project.projectService.logger.info(`TSPP feature plugin '${tsppPlugin.manifest.id}' activated`);
    if (!projectsWithAnalysis.has(project)) {
        projectsWithAnalysis.add(project);
        const upstreamLanguageService = project.getLanguageService(/*ensureSynchronized*/ false);
        let analyzedProgram: Program | undefined;
        let pendingProgram: Program | undefined;
        let analysisDiagnostics: readonly Diagnostic[] = emptyArray;
        const languageService = Object.create(upstreamLanguageService) as LanguageService;
        languageService.getSemanticDiagnostics = fileName => {
            const diagnostics = upstreamLanguageService.getSemanticDiagnostics(fileName);
            const program = upstreamLanguageService.getProgram();
            if (!program || !hasTSPPProgramAnalyzers()) return diagnostics;
            if (analyzedProgram === program) {
                return [...diagnostics, ...analysisDiagnostics.filter(diagnostic => diagnostic.file?.fileName === fileName)];
            }
            if (pendingProgram !== program) {
                pendingProgram = program;
                void runTSPPProgramAnalyzers(program).then(
                    results => {
                        if (upstreamLanguageService.getProgram() !== program) return;
                        analysisDiagnostics = results.map(diagnostic => toTSPPAnalysisDiagnostic(program, diagnostic));
                        analyzedProgram = program;
                        pendingProgram = undefined;
                        project.refreshDiagnostics();
                    },
                    error => {
                        pendingProgram = undefined;
                        project.projectService.logger.info(`TSPP program analysis failed: ${error instanceof Error ? error.message : String(error)}`);
                    },
                );
            }
            return diagnostics;
        };
        setLanguageService(languageService);
    }
    plugins.push({
        name: configEntry.name,
        module: { create: info => info.languageService },
    });
    return true;
}
