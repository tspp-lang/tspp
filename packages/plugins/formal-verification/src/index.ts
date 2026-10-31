import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type {
    TSPPAnalysisDiagnostic,
    TSPPAnalysisArtifact,
    TSPPProgramAnalyzer,
} from "@tspp/plugin-sdk/compiler";
import { maskContractClauses, type PendingProof } from "./contracts";
import { collectProgramProofs } from "./program";
import { renderZ3Query, solveWithZ3Cached } from "./solver";
import { collectLogicLibrary } from "./logic";

export const formalVerificationAnalyzer: TSPPProgramAnalyzer = {
    id: "proof-points",
    async analyze(input) {
        const diagnostics: TSPPAnalysisDiagnostic[] = [];
        const queries: { proof: PendingProof; }[] = [];
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
            for (const proof of collectProgramProofs(sourceFile, diagnostics, logic)) queries.push({ proof });
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
    },
};

export const formalVerificationPlugin = definePlugin({
    manifest: {
        id: "formal-verification/z3",
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Z3 formal verification",
        optionalDependencies: ["nominal-types"],
        capabilities: ["analysis-artifacts", "formal-contracts", "smt-libraries"],
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
            commands: [{ id: "tspp.showSmtSource", title: "TS++: Show SMT Source" }],
            grammars: ["./editor/verification.tmLanguage.json"],
        },
    },
});

export default formalVerificationPlugin;
