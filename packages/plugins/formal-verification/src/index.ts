import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type {
    TSPPAnalysisDiagnostic,
    TSPPAnalysisArtifact,
    TSPPProgramAnalyzer,
} from "@tspp/plugin-sdk/compiler";
import { maskContractClauses, type PendingProof } from "./contracts";
import { collectProgramProofs } from "./program";
import { renderZ3Query, solveWithZ3 } from "./solver";

export const formalVerificationAnalyzer: TSPPProgramAnalyzer = {
    id: "proof-points",
    async analyze(input) {
        const diagnostics: TSPPAnalysisDiagnostic[] = [];
        const queries: { proof: PendingProof; }[] = [];
        for (const sourceFile of input.sourceFiles) {
            for (const proof of collectProgramProofs(sourceFile, diagnostics)) queries.push({ proof });
        }
        const answers = await solveWithZ3(queries.map(query => query.proof.query));
        const artifacts: TSPPAnalysisArtifact[] = [];
        answers.forEach((answer, index) => {
            const proof = queries[index].proof;
            const status = answer.status === "unsat" ? "proved" : answer.status === "sat" ? "failed" : answer.status;
            artifacts.push({
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
    },
};

export const formalVerificationPlugin = definePlugin({
    manifest: {
        id: "formal-verification/z3",
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Z3 formal verification",
    },
    facets: {
        compiler: {
            activate(context) {
                const disposeProjection = context.compiler.registerSourcePreprocessor({
                    id: "contract-projection",
                    preprocess: maskContractClauses,
                });
                const disposeAnalysis = context.compiler.registerProgramAnalyzer(formalVerificationAnalyzer);
                return () => {
                    disposeAnalysis();
                    disposeProjection();
                };
            },
        },
        editor: {
            commands: [{ id: "tspp.showAnalysisArtifacts", title: "TS++: Show Analysis Artifacts" }],
            grammars: ["./editor/verification.tmLanguage.json"],
        },
    },
});

export default formalVerificationPlugin;
