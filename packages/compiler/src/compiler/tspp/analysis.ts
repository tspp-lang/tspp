import type {
    TSPPAnalysisArtifact,
    TSPPAnalysisDiagnostic,
    TSPPProgramAnalysisInput,
} from "@tspp/plugin-sdk/compiler";

import { normalizePath } from "../path.js";
import type {
    Diagnostic,
    Program,
} from "../types.js";
import { DiagnosticCategory } from "../types.js";
import {
    getOriginalTSPPSource,
    getRegisteredTSPPProgramAnalyzers,
} from "./registry.js";

const analysisArtifacts = new WeakMap<Program, readonly TSPPAnalysisArtifact[]>();
const analysisResults = new WeakMap<Program, Promise<readonly TSPPAnalysisDiagnostic[]>>();

function snapshotProgram(program: Program): TSPPProgramAnalysisInput {
    const rootNames = new Set(program.getRootFileNames());
    return {
        currentDirectory: program.getCurrentDirectory(),
        rootFileNames: [...rootNames],
        sourceFiles: program.getSourceFiles()
            .filter(sourceFile => rootNames.has(sourceFile.fileName) && !sourceFile.isDeclarationFile)
            .map(sourceFile => ({
                fileName: sourceFile.fileName,
                text: getOriginalTSPPSource(sourceFile.fileName, sourceFile.text),
            })),
    };
}

/** Runs isolated feature analyzers without exposing compiler-owned objects. @internal */
export async function runTSPPProgramAnalyzers(program: Program): Promise<readonly any[]> {
    const existing = analysisResults.get(program);
    if (existing) return existing;
    const analyzers = getRegisteredTSPPProgramAnalyzers();
    if (!analyzers.length) return [];
    const pending = (async () => {
        const input = snapshotProgram(program);
        const diagnostics = await Promise.all(analyzers.map(analyzer => analyzer.analyze(input)));
        analysisArtifacts.set(program, diagnostics.flatMap(result => result.artifacts ?? []));
        return diagnostics.flat();
    })();
    analysisResults.set(program, pending);
    try {
        return await pending;
    }
    catch (error) {
        analysisResults.delete(program);
        throw error;
    }
}

/** Returns artifacts from the most recent analyzer run for this program. @internal @knipignore */
export function getTSPPAnalysisArtifacts(program: Program, fileName?: string): readonly any[] {
    const artifacts = analysisArtifacts.get(program) ?? [];
    if (fileName === undefined) return artifacts;
    const normalized = normalizePath(fileName);
    return artifacts.filter(artifact => normalizePath(artifact.fileName) === normalized);
}

/** @internal */
export function hasTSPPProgramAnalyzers(): boolean {
    return getRegisteredTSPPProgramAnalyzers().length !== 0;
}

/** Converts an analyzer diagnostic into a compiler diagnostic of `program`. @internal */
export function toTSPPAnalysisDiagnostic(program: Program, diagnostic: TSPPAnalysisDiagnostic): Diagnostic {
    return {
        category: diagnostic.category === "error" ? DiagnosticCategory.Error : DiagnosticCategory.Warning,
        code: diagnostic.code,
        file: program.getSourceFile(diagnostic.fileName),
        start: diagnostic.start,
        length: diagnostic.length,
        source: diagnostic.source,
        messageText: diagnostic.message,
    };
}
