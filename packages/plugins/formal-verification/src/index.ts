import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type {
    TSPPAnalysisDiagnostic,
    TSPPProgramAnalyzer,
} from "@tspp/plugin-sdk/compiler";
import { maskContractClauses, type PendingProof } from "./contracts";
import { collectProgramProofs } from "./program";
import { solveWithZ3 } from "./solver";

export const formalVerificationAnalyzer: TSPPProgramAnalyzer = {
    id: "proof-points",
    async analyze(input) {
        const diagnostics: TSPPAnalysisDiagnostic[] = [];
        const queries: { proof: PendingProof; }[] = [];
        for (const sourceFile of input.sourceFiles) {
            for (const proof of collectProgramProofs(sourceFile, diagnostics)) queries.push({ proof });
        }
        const answers = await solveWithZ3(queries.map(query => query.proof.query));
        answers.forEach((answer, index) => {
            if (answer.status === "unsat") return;
            const proof = queries[index].proof;
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
            grammars: ["./editor/verification.tmLanguage.json"],
        },
    },
});

export default formalVerificationPlugin;
