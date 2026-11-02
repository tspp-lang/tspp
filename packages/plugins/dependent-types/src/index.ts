import {
    inferMlttType,
    normalizeMlttTerm,
    printMlttTerm,
    type MlttTerm,
    MlttTypeError,
} from "./core";
import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type {
    TSPPAnalysisDiagnostic,
    TSPPAnalysisArtifact,
    TSPPProgramAnalyzer,
} from "@tspp/plugin-sdk/compiler";
import { createReification } from "./reification";
import {
    checkDependentTypeAnnotation,
    collectDependentTypeAliases,
    inferDependentTypeUniverse,
    parseDependentType,
    projectDependentTypes,
    restoreDependentTypeAlias,
} from "./syntax";

export const dependentTypesAnalyzer: TSPPProgramAnalyzer = {
    id: "mltt-types",
    async analyze(input) {
        const diagnostics: TSPPAnalysisDiagnostic[] = [];
        const artifacts: TSPPAnalysisArtifact[] = [];
        for (const sourceFile of input.sourceFiles) {
            const aliases = new Map<string, MlttTerm>();
            for (const alias of collectDependentTypeAliases(sourceFile.text)) {
                try {
                    const term = parseDependentType(alias.expression, aliases);
                    if (alias.annotationLevel === undefined) {
                        checkDependentTypeAnnotation(term, alias.annotation, aliases);
                    }
                    else {
                        const actualLevel = inferDependentTypeUniverse(term);
                        if (actualLevel !== alias.annotationLevel) {
                            throw new Error(
                                `Type '${alias.name}' has kind Type${actualLevel}, not Type${alias.annotationLevel}.`,
                            );
                        }
                    }
                    aliases.set(alias.name, term);
                    const normalForm = normalizeMlttTerm(term);
                    const normalType = normalizeMlttTerm(inferMlttType(term));
                    artifacts.push({
                        kind: "dependent-types/normal-form",
                        fileName: sourceFile.fileName,
                        start: alias.expressionStart,
                        length: Math.max(1, alias.expressionEnd - alias.expressionStart),
                        name: `${alias.name} normal form`,
                        language: "plaintext",
                        status: "proved",
                        content: `${alias.name} : ${printMlttTerm(normalType)}\n${alias.name} = ${printMlttTerm(normalForm)}\n`,
                    });
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
        Object.defineProperty(diagnostics, "artifacts", { value: artifacts });
        return diagnostics;
    },
};

export const dependentTypesPlugin = definePlugin({
    manifest: {
        id: "type-system/dependent-types",
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Martin-Löf dependent types",
        capabilities: ["analysis-artifacts", "dependent-types", "runtime-type-reification"],
        syntax: {
            keywords: [
                { keyword: "reify", position: "expression" },
                { keyword: "typecase", position: "expression" },
                { keyword: ":", position: "type-alias-annotation" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const reification = createReification(context.ts);
                context.onDispose(context.compiler.registerSyntaxExtension(reification.reify));
                context.onDispose(context.compiler.registerSyntaxExtension(reification.typecase));
                context.onDispose(context.compiler.registerProgramRebuilder(reification.selection));
                const disposeProjection = context.compiler.registerSourcePreprocessor({
                    id: "mltt-projection",
                    preprocess: projectDependentTypes,
                    restoreTypeAliasDeclaration: restoreDependentTypeAlias,
                });
                const disposeAnalysis = context.compiler.registerProgramAnalyzer(dependentTypesAnalyzer);
                return () => {
                    disposeAnalysis();
                    disposeProjection();
                };
            },
        },
        languageService: {
            activate(context) {
                return context.languageService.registerQuickInfoProvider(request => {
                    const alias = collectDependentTypeAliases(request.sourceText)
                        .find(candidate => candidate.nameStart <= request.position && request.position <= candidate.nameEnd);
                    if (alias) {
                        return {
                            start: alias.nameStart,
                            length: alias.nameEnd - alias.nameStart,
                            display: `type ${alias.name}: ${alias.annotation} = ${alias.expression}`,
                            documentation: "A Martin-Löf dependent type alias checked by the TS++ dependent-types plugin.",
                        };
                    }
                    const match = wordAt(request.sourceText, request.position);
                    if (!match) return undefined;
                    const documentation = dependentTypeDocumentation(match.text);
                    if (!documentation) return undefined;
                    return {
                        start: match.start,
                        length: match.text.length,
                        display: `(TS++ dependent types) ${match.text}`,
                        documentation,
                    };
                });
            },
        },
        editor: {
            commands: [{ id: "tspp.showMlttNormalForms", title: "TS++: Show MLTT Normal Forms" }],
            grammars: ["./editor/dependent-types.tmLanguage.json"],
        },
    },
});

function dependentTypeDocumentation(word: string): string | undefined {
    if (/^Type\d*$/.test(word)) return "A universe of types. A numeric suffix selects a higher universe level.";
    if (word === "reify") return "Creates a runtime descriptor for the following static type.";
    if (word === "typecase") return "Matches a type, or a runtime type descriptor, against type patterns in order.";
    return undefined;
}

function wordAt(sourceText: string, position: number): { readonly start: number; readonly text: string; } | undefined {
    const expression = /[A-Za-z][A-Za-z0-9]*/g;
    for (let match = expression.exec(sourceText); match; match = expression.exec(sourceText)) {
        if (match.index <= position && position <= match.index + match[0].length) {
            return { start: match.index, text: match[0] };
        }
    }
    return undefined;
}

export {
    checkDependentTypeAnnotation,
    collectDependentTypeAliases,
    inferDependentTypeUniverse,
    parseDependentType,
    projectDependentTypes,
    restoreDependentTypeAlias,
} from "./syntax";

export default dependentTypesPlugin;

