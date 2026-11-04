import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import { isTypeScriptKeyword, scanTSPPCode } from "@tspp/plugin-sdk/language-service";
import type { TSPPSemanticToken, TSPPSemanticTokensRequest } from "@tspp/plugin-sdk/language-service";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
import type {
    TSPPAnalysisDiagnostic,
    TSPPAnalysisArtifact,
    TSPPProgramAnalysisInput,
    TSPPProgramAnalysisOutput,
    TSPPProgramAnalyzer,
} from "@tspp/plugin-sdk/compiler";
import { createProofDirectives, maskContractClauses, restoreContractFunctionClause, type PendingProof } from "./contracts";
import { collectProgramProofs } from "./program";
import { clearZ3AnswerCache, renderZ3Query, solveWithZ3Cached } from "./solver";
import { collectLogicLibrary } from "./logic";
import { clearPreparedVerificationSources } from "./source-cache";
import { createRefinementClauses } from "./refinements";
import { useTypeScript } from "./host-api";

export interface FormalVerificationAnalyzerOptions {
    /**
     * Returns the nominal-types ADT API, which lets proofs model `data` declarations, or undefined when nominal-types
     * is not installed. Called per analysis because nominal-types may be registered after this plugin.
     */
    readonly getNominalTypes?: () => NominalTypesADTAPI | undefined;
}

export function createFormalVerificationAnalyzer(options: FormalVerificationAnalyzerOptions = {}): TSPPProgramAnalyzer {
    return {
        id: "proof-points",
        analyze: input => analyze(input, options),
    };
}

export const formalVerificationAnalyzer = createFormalVerificationAnalyzer();

async function analyze(input: TSPPProgramAnalysisInput, options: FormalVerificationAnalyzerOptions): Promise<TSPPProgramAnalysisOutput> {
    const diagnostics: TSPPAnalysisDiagnostic[] = [];
    const queries: { proof: PendingProof; }[] = [];
    const nominalTypes = options.getNominalTypes?.();
    let logic;
    try { logic = collectLogicLibrary(input.sourceFiles.map(sourceFile => sourceFile.text)); }
    catch (error) {
        diagnostics.push({
            fileName: input.sourceFiles[0]?.fileName ?? "<program>", start: 0, length: 0,
            code: 19004, category: "error", source: "TS++ verification",
            message: error instanceof Error ? error.message : String(error),
        });
        return diagnostics;
    }
    for (const sourceFile of input.sourceFiles) {
        // Other files can hold logic definitions, but contracts and directives are TS++ syntax.
        if (!sourceFile.fileName.endsWith(".tspp")) continue;
        for (const proof of collectProgramProofs(sourceFile, diagnostics, logic, nominalTypes)) queries.push({ proof });
    }
    const answers = await solveWithZ3Cached(queries.map(query => query.proof.query));
    const artifacts: TSPPAnalysisArtifact[] = [];
    answers.forEach((answer, index) => {
        const proof = queries[index].proof;
        const status = answer.status === "unsat" ? "proved" : answer.status === "sat" ? "failed" : answer.status;
        artifacts.push({
            kind: "formal-verification/smt",
            fileName: proof.fileName, start: proof.start, length: proof.length,
            name: proof.name, language: "smt2", status,
            content: `; ${proof.name}: ${status}\n${renderZ3Query(proof.query)}\n`,
        });
        if (answer.status === "unsat") return;
        diagnostics.push({
            fileName: proof.fileName,
            start: proof.start,
            length: proof.length,
            code: 19002,
            category: "error",
            source: "TS++ verification",
            message: answer.status === "sat"
                ? `${proof.name} could not be proved. Counterexample: ${answer.output?.replace(/[()\s]/g, "") ? answer.output.trim() : "the condition is false"}`
                : `${proof.name} verification ${answer.status}: ${answer.message ?? "the solver returned no result"}`,
        });
    });
    Object.defineProperty(diagnostics, "artifacts", { value: artifacts });
    return diagnostics;
}

export const formalVerificationPlugin = definePlugin({
    manifest: {
        id: "formal-verification/z3",
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Z3 formal verification",
        optionalDependencies: ["nominal-types"],
        capabilities: ["analysis-artifacts", "formal-contracts", "smt-libraries"],
        syntax: {
            keywords: [
                { keyword: "with", position: "function-clause" },
                { keyword: "with", position: "loop-clause" },
                { keyword: "with", position: "postfix-type" },
                { keyword: "assert", position: "statement" },
                { keyword: "assume", position: "statement" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                useTypeScript(context.ts);
                const disposeProjection = context.compiler.registerSourcePreprocessor({
                    id: "contract-projection",
                    claims: [
                        { keyword: "with", position: "function-clause" },
                        { keyword: "with", position: "loop-clause" },
                    ],
                    preprocess: maskContractClauses,
                    restoreFunctionClause: restoreContractFunctionClause,
                });
                context.onDispose(context.compiler.registerSyntaxExtension(createProofDirectives(context.ts)));
                context.onDispose(context.compiler.registerSyntaxExtension(createRefinementClauses(context.ts)));
                const disposeAnalysis = context.compiler.registerProgramAnalyzer(createFormalVerificationAnalyzer({
                    getNominalTypes: () => context.dependencies.get<NominalTypesADTAPI>("nominal-types/adt"),
                }));
                return () => {
                    disposeAnalysis();
                    disposeProjection();
                    clearPreparedVerificationSources();
                    clearZ3AnswerCache();
                };
            },
        },
        languageService: {
            activate(context) {
                context.onDispose(context.languageService.registerSemanticTokensProvider(verificationTermTokens));
                return context.languageService.registerQuickInfoProvider(request => {
                    const match = request.owned ? wordAt(request.sourceText, request.position) : undefined;
                    const documentation = match && contractDocumentation[match.text];
                    // A name in a directive or a clause means something only to proofs, so the checker has no type for it.
                    if (match && !documentation && (!request.upstream || request.upstream.display === "any")) {
                        return { start: match.start, length: match.text.length, display: `(TS++ verification term) ${match.text}` };
                    }
                    if (!match || !documentation) return undefined;
                    return {
                        start: match.start,
                        length: match.text.length,
                        display: `(TS++ verification clause) ${match.text}`,
                        documentation,
                    };
                });
            },
        },
        editor: {
            keywords: ["requires", "ensures", "invariant", "predicate", "numberModel"],
            artifactViews: [{
                commandId: "tspp.showSmtSource",
                title: "TS++: Show SMT Source",
                label: "SMT-LIB2",
                artifactKind: "formal-verification/smt",
                emptyMessage: "This file has no SMT source.",
            }],
            grammars: ["./editor/verification.tmLanguage.json"],
        },
    },
});

const contractDocumentation: Readonly<Record<string, string>> = {
    requires: "Declares a precondition assumed while proving the function body.",
    ensures: "Declares a postcondition that must hold for every function result.",
    assert: "Creates a proof obligation at this program point.",
    assume: "Adds a fact the proofs after this point may use, without proving it.",
    predicate: "Declares the condition every value of a refinement type satisfies.",
    invariant: "Declares a loop invariant checked before and after every iteration.",
};

/** Terms of proofs are names only the solver reads, which nothing classifies: they render alike, as variables do. */
function verificationTermTokens(request: TSPPSemanticTokensRequest): TSPPSemanticToken[] {
    const classified = new Set(request.tokens.map(token => token.start));
    const tokens: TSPPSemanticToken[] = [];
    for (const token of scanTSPPCode(request.sourceText)) {
        if (token.kind !== "name" || classified.has(token.start) || contractDocumentation[token.text] || isTypeScriptKeyword(token.text)) continue;
        if (request.isOwned(token.start, token.start + token.text.length)) tokens.push({ start: token.start, length: token.text.length, type: "variable" });
    }
    return tokens;
}

function wordAt(sourceText: string, position: number): { readonly start: number; readonly text: string; } | undefined {
    const expression = /[A-Za-z_$][\w$]*/g;
    for (let match = expression.exec(sourceText); match; match = expression.exec(sourceText)) {
        if (match.index <= position && position <= match.index + match[0].length) {
            return { start: match.index, text: match[0] };
        }
    }
    return undefined;
}

export default formalVerificationPlugin;
export { configureZ3Solver, verificationProgramSemantics } from "./solver";
export type { Z3Answer, Z3Query, Z3Solver } from "./solver";
