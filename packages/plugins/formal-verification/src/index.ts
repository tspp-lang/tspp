import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type {
    TSPPAnalysisDiagnostic,
    TSPPAnalysisNode,
    TSPPProgramAnalyzer,
} from "@tspp/plugin-sdk/compiler";
import { expressionToSmt } from "./expression";
import { solveWithZ3 } from "./solver";

interface ProofPoint {
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly expression: string;
}

function visit(node: TSPPAnalysisNode, callback: (node: TSPPAnalysisNode) => void): void {
    callback(node);
    for (const child of node.children) visit(child, callback);
}

export const formalVerificationAnalyzer: TSPPProgramAnalyzer = {
    id: "proof-points",
    async analyze(input) {
        const points: ProofPoint[] = [];
        const diagnostics: TSPPAnalysisDiagnostic[] = [];
        for (const sourceFile of input.sourceFiles) {
            visit(sourceFile.root, node => {
                if (node.kind !== input.syntaxKinds.labeledStatement) return;
                const match = /^assert\s*:\s*([\s\S]*?)\s*;?$/.exec(node.text);
                if (!match) return;
                const relativeStart = node.text.indexOf(match[1]);
                points.push({
                    fileName: sourceFile.fileName,
                    start: node.start + relativeStart,
                    length: match[1].length,
                    expression: match[1],
                });
            });
        }
        const queries: { expression: string; point: ProofPoint; }[] = [];
        for (const point of points) {
            try {
                queries.push({ expression: expressionToSmt(point.expression), point });
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
        const answers = await solveWithZ3(queries.map(query => ({ expression: query.expression })));
        answers.forEach((answer, index) => {
            if (answer.status === "unsat") return;
            const point = queries[index].point;
            diagnostics.push({
                fileName: point.fileName,
                start: point.start,
                length: point.length,
                code: 19002,
                category: "error",
                source: "TS++ verification",
                message: answer.status === "sat"
                    ? `Assertion could not be proved. Counterexample: ${answer.output?.replace(/[()\s]/g, "") ? answer.output.trim() : "the condition is false"}`
                    : `Assertion verification ${answer.status}: ${answer.message ?? "the solver returned no result"}`,
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
                return context.compiler.registerProgramAnalyzer(formalVerificationAnalyzer);
            },
        },
    },
});

export default formalVerificationPlugin;
