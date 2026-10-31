import type {
    TSPPAnalysisDiagnostic,
    TSPPAnalysisArtifact,
    TSPPAnalysisNode,
    TSPPProgramAnalysisInput,
} from "@tspp/plugin-sdk/compiler";

import { forEachChild } from "../parser.js";
import { skipTrivia } from "../scanner.js";
import { normalizePath } from "../path.js";
import type { Node, Program, SourceFile } from "../types.js";
import { SyntaxKind } from "../types.js";
import { getOriginalTSPPSource, getRegisteredTSPPProgramAnalyzers } from "./registry.js";

const analysisArtifacts = new WeakMap<Program, readonly TSPPAnalysisArtifact[]>();

function snapshotNode(sourceFile: SourceFile, node: Node): TSPPAnalysisNode {
    const children: TSPPAnalysisNode[] = [];
    forEachChild(node, child => {
        children.push(snapshotNode(sourceFile, child));
        return undefined;
    });
    const start = skipTrivia(sourceFile.text, node.pos);
    return {
        kind: node.kind,
        start,
        end: node.end,
        text: sourceFile.text.slice(start, node.end),
        children,
    };
}

function snapshotProgram(program: Program): TSPPProgramAnalysisInput {
    const rootNames = new Set(program.getRootFileNames());
    return {
        currentDirectory: program.getCurrentDirectory(),
        rootFileNames: [...rootNames],
        syntaxKinds: {
            sourceFile: SyntaxKind.SourceFile,
            labeledStatement: SyntaxKind.LabeledStatement,
        },
        sourceFiles: program.getSourceFiles()
            .filter(sourceFile => rootNames.has(sourceFile.fileName) && !sourceFile.isDeclarationFile)
            .map(sourceFile => {
                const original = getOriginalTSPPSource(sourceFile.fileName, sourceFile.text);
                const snapshotSource = original === sourceFile.text ? sourceFile : { ...sourceFile, text: original } as SourceFile;
                return {
                    fileName: sourceFile.fileName,
                    text: original,
                    root: snapshotNode(snapshotSource, sourceFile),
                };
            }),
    };
}

/** Runs isolated feature analyzers without exposing compiler-owned objects. @internal */
export async function runTSPPProgramAnalyzers(program: Program): Promise<readonly TSPPAnalysisDiagnostic[]> {
    const analyzers = getRegisteredTSPPProgramAnalyzers();
    if (!analyzers.length) return [];
    const input = snapshotProgram(program);
    const diagnostics = await Promise.all(analyzers.map(analyzer => analyzer.analyze(input)));
    analysisArtifacts.set(program, diagnostics.flatMap(result => result.artifacts ?? []));
    return diagnostics.flat();
}

/** Returns artifacts from the most recent analyzer run for this program. @internal */
export function getTSPPAnalysisArtifacts(program: Program, fileName?: string): readonly TSPPAnalysisArtifact[] {
    const artifacts = analysisArtifacts.get(program) ?? [];
    if (fileName === undefined) return artifacts;
    const normalized = normalizePath(fileName);
    return artifacts.filter(artifact => normalizePath(artifact.fileName) === normalized);
}

/** @internal */
export function hasTSPPProgramAnalyzers(): boolean {
    return getRegisteredTSPPProgramAnalyzers().length !== 0;
}
