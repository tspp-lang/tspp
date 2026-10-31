import { type MlttTerm, MlttTypeError } from "./core";
import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type { TSPPAnalysisDiagnostic, TSPPProgramAnalyzer } from "@tspp/plugin-sdk/compiler";
import {
    collectDependentTypeAliases,
    inferDependentTypeUniverse,
    parseDependentType,
    projectDependentTypes,
} from "./syntax";

export const dependentTypesAnalyzer: TSPPProgramAnalyzer = {
    id: "mltt-types",
    async analyze(input) {
        const diagnostics: TSPPAnalysisDiagnostic[] = [];
        for (const sourceFile of input.sourceFiles) {
            const aliases = new Map<string, MlttTerm>();
            for (const alias of collectDependentTypeAliases(sourceFile.text)) {
                try {
                    const term = parseDependentType(alias.expression, aliases);
                    const actualLevel = inferDependentTypeUniverse(term);
                    if (actualLevel !== alias.annotationLevel) {
                        throw new Error(
                            `Type '${alias.name}' has kind Type${actualLevel}, not Type${alias.annotationLevel}.`,
                        );
                    }
                    aliases.set(alias.name, term);
                }
                catch (error) {
                    diagnostics.push({
                        fileName: sourceFile.fileName,
                        start: alias.expressionStart,
                        length: Math.max(1, alias.expressionEnd - alias.expressionStart),
                        code: error instanceof MlttTypeError ? 19102 : 19101,
                        category: "error",
                        source: "TS++ dependent types",
                        message: error instanceof Error ? error.message : String(error),
                    });
                }
            }
        }
        return diagnostics;
    },
};

export const dependentTypesPlugin = definePlugin({
    manifest: {
        id: "type-system/dependent-types",
        version: "0.0.1",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Martin-Löf dependent types",
    },
    facets: {
        compiler: {
            activate(context) {
                const disposeProjection = context.compiler.registerSourcePreprocessor({
                    id: "mltt-projection",
                    preprocess: projectDependentTypes,
                });
                const disposeAnalysis = context.compiler.registerProgramAnalyzer(dependentTypesAnalyzer);
                return () => {
                    disposeAnalysis();
                    disposeProjection();
                };
            },
        },
        editor: {
            grammars: ["./editor/dependent-types.tmLanguage.json"],
        },
    },
});

export {
    collectDependentTypeAliases,
    inferDependentTypeUniverse,
    parseDependentType,
    projectDependentTypes,
} from "./syntax";

export default dependentTypesPlugin;

