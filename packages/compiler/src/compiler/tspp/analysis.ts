import type {
    TSPPAnalysisArtifact,
    TSPPAnalysisCallTarget,
    TSPPAnalysisDiagnostic,
    TSPPAnalysisLocation,
    TSPPProgramAnalysisInput,
} from "@tspp/plugin-sdk/compiler";

import * as ts from "../_namespaces/ts.js";
import { normalizePath } from "../path.js";
import type {
    Diagnostic,
    Expression,
    Node,
    Program,
    SourceFile,
} from "../types.js";
import {
    DiagnosticCategory,
    SymbolFlags,
    SyntaxKind,
} from "../types.js";
import {
    getOriginalTSPPSource,
    getRegisteredTSPPProgramAnalyzers,
} from "./registry.js";

const analysisArtifacts = new WeakMap<Program, readonly TSPPAnalysisArtifact[]>();
const analysisResults = new WeakMap<Program, Promise<readonly TSPPAnalysisDiagnostic[]>>();

function snapshotProgram(program: Program, withCallTargets: boolean): TSPPProgramAnalysisInput {
    const rootNames = new Set(program.getRootFileNames());
    return {
        currentDirectory: program.getCurrentDirectory(),
        rootFileNames: [...rootNames],
        sourceFiles: program.getSourceFiles()
            .filter(sourceFile => rootNames.has(sourceFile.fileName) && !sourceFile.isDeclarationFile)
            .map(sourceFile => ({
                fileName: sourceFile.fileName,
                text: getOriginalTSPPSource(sourceFile.fileName, sourceFile.text),
                ...(withCallTargets ? { callTargets: collectCallTargets(program, sourceFile) } : {}),
            })),
    };
}

/** A node's range from its first token; plugins keep projected text the same length as the authored text. */
function locate(node: Node): TSPPAnalysisLocation {
    const sourceFile = ts.getSourceFileOfNode(node);
    return { fileName: sourceFile.fileName, start: ts.skipTrivia(sourceFile.text, node.pos), end: node.end };
}

/** The node that names what a callee calls: an identifier, or the name of a property access. */
function calleeName(callee: Expression): Node | undefined {
    const expression = ts.skipParentheses(callee);
    if (ts.isIdentifier(expression)) return expression;
    if (ts.isPropertyAccessExpression(expression)) return expression.name;
    return undefined;
}

/**
 * The declarations of the symbol each call's callee names, resolved by the checker. A `super(...)` call resolves to
 * the base class, like a `new` of it.
 */
function collectCallTargets(program: Program, sourceFile: SourceFile): TSPPAnalysisCallTarget[] {
    const checker = program.getTypeChecker();
    const targets: TSPPAnalysisCallTarget[] = [];
    const visit = (node: Node): void => {
        if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && !ts.nodeIsSynthesized(node)) {
            let name: Node | undefined;
            if (node.expression.kind === SyntaxKind.SuperKeyword) {
                const owner = ts.getContainingClass(node);
                const base = owner && ts.getClassExtendsHeritageElement(owner)?.expression;
                name = base && calleeName(base);
            }
            else name = calleeName(node.expression);
            let symbol = name && checker.getSymbolAtLocation(name);
            if (symbol && symbol.flags & SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
            const declarations = symbol?.declarations?.filter(declaration => !ts.nodeIsSynthesized(declaration)).map(locate);
            if (declarations?.length) targets.push({ start: ts.skipTrivia(sourceFile.text, node.pos), end: node.end, declarations });
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return targets;
}

/** Runs isolated feature analyzers without exposing compiler-owned objects. @internal */
export async function runTSPPProgramAnalyzers(program: Program): Promise<readonly any[]> {
    const existing = analysisResults.get(program);
    if (existing) return existing;
    const analyzers = getRegisteredTSPPProgramAnalyzers();
    if (!analyzers.length) return [];
    const pending = (async () => {
        const input = snapshotProgram(program, analyzers.some(analyzer => analyzer.needsCallTargets));
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
