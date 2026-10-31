import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type {
    TSPPAnalysisDiagnostic,
    TSPPProgramAnalyzer,
} from "@tspp/plugin-sdk/compiler";
import { expressionToSmt } from "./expression";
import { collectContractProofs, maskContractClauses, type PendingProof } from "./contracts";
import { solveWithZ3 } from "./solver";

interface ProofPoint {
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly expression: string;
}

export const formalVerificationAnalyzer: TSPPProgramAnalyzer = {
    id: "proof-points",
    async analyze(input) {
        const points: ProofPoint[] = [];
        const diagnostics: TSPPAnalysisDiagnostic[] = [];
        for (const sourceFile of input.sourceFiles) {
            const pattern = /\bassert\s*:\s*([^;]+);/g;
            for (let match; (match = pattern.exec(sourceFile.text));) {
                const relativeStart = match.index + match[0].indexOf(match[1]);
                points.push({
                    fileName: sourceFile.fileName,
                    start: relativeStart,
                    length: match[1].length,
                    expression: match[1],
                });
            }
        }
        const queries: { proof: PendingProof; point?: ProofPoint; }[] = [];
        for (const point of points) {
            try {
                queries.push({
                    point,
                    proof: {
                        query: { goal: expressionToSmt(point.expression) },
                        fileName: point.fileName,
                        start: point.start,
                        length: point.length,
                        name: "assertion",
                    },
                });
            }
            catch (error) {
                diagnostics.push({
                    fileName: point.fileName,
                    start: point.start,
                    length: point.length,
                    code: 19001,
                    category: "error",
                    source: "TS++ verification",
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        for (const sourceFile of input.sourceFiles) {
            for (const proof of collectContractProofs(sourceFile, diagnostics)) queries.push({ proof });
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
        version: "0.0.1",
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
