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
    TSPPExpressionSyntax,
    TSPPExtensionExpression,
    TSPPProgramAnalyzer,
    TSPPReifiedTypeMatchArm,
    TSPPExpression,
    TSPPTypeNode,
} from "@tspp/plugin-sdk/compiler";
import {
    checkDependentTypeAnnotation,
    collectDependentTypeAliases,
    inferDependentTypeUniverse,
    parseDependentType,
    projectDependentTypes,
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
    },
    facets: {
        compiler: {
            activate(context) {
                const kinds = context.compiler.expressionSyntaxKinds;
                const reifiedTypes = new WeakMap<TSPPExtensionExpression, TSPPTypeNode>();
                const reifiedMatches = new WeakMap<TSPPExtensionExpression, {
                    readonly scrutinee: TSPPExpression;
                    readonly arms: readonly TSPPReifiedTypeMatchArm[];
                }>();
                const reifySyntax: TSPPExpressionSyntax = {
                    startTokens: [kinds.identifier],
                    isStart: parser => parser.tokenText() === "reify" && parser.lookAhead(() => {
                        parser.nextToken();
                        return !parser.hasPrecedingLineBreak();
                    }),
                    parse: parser => {
                        const pos = parser.getNodePos();
                        parser.nextToken();
                        const type = parser.parseType();
                        const expression = parser.finishExpression([type], pos);
                        reifiedTypes.set(expression, type);
                        return expression;
                    },
                    check: (node, checker) => checker.createReifiedType(getReifiedType(node, reifiedTypes)),
                    transform: (node, transformer) =>
                        transformer.createReifiedTypeDescriptor(getReifiedType(node, reifiedTypes)),
                };
                const matchSyntax: TSPPExpressionSyntax = {
                    startTokens: [kinds.identifier],
                    isStart: parser => parser.tokenText() === "match" && parser.lookAhead(() => {
                        parser.nextToken();
                        return parser.tokenText() === "mltt" && !parser.hasPrecedingLineBreak();
                    }),
                    parse: parser => {
                        const pos = parser.getNodePos();
                        parser.nextToken();
                        if (parser.tokenText() !== "mltt") throw new Error("Expected 'mltt' after 'match'.");
                        parser.nextToken();
                        const scrutinee = parser.parseAssignmentExpression();
                        parser.parseExpected(kinds.openBraceToken);
                        const arms: TSPPReifiedTypeMatchArm[] = [];
                        const children: (TSPPExpression | TSPPTypeNode)[] = [scrutinee];
                        while (parser.token() !== kinds.closeBraceToken && parser.token() !== kinds.endOfFileToken) {
                            let pattern: TSPPTypeNode | undefined;
                            if (parser.tokenText() === "_") parser.nextToken();
                            else pattern = parser.parseType();
                            parser.parseExpected(kinds.equalsGreaterThanToken);
                            const result = parser.parseAssignmentExpression();
                            arms.push({ pattern, result });
                            if (pattern) children.push(pattern);
                            children.push(result);
                            if (parser.token() === kinds.commaToken || parser.token() === kinds.semicolonToken) {
                                parser.nextToken();
                            }
                            else break;
                        }
                        parser.parseExpected(kinds.closeBraceToken);
                        if (!arms.length || arms[arms.length - 1].pattern) {
                            throw new Error("A reified type match must end with an '_' arm.");
                        }
                        const expression = parser.finishExpression(children, pos);
                        reifiedMatches.set(expression, { scrutinee, arms });
                        return expression;
                    },
                    check: (node, checker, checkMode) => {
                        const match = getReifiedMatch(node, reifiedMatches);
                        return checker.checkReifiedTypeMatch(node, match.scrutinee, match.arms, checkMode);
                    },
                    transform: (node, transformer) => transformer.getSelectedExpression(node),
                };
                const disposeReify = context.compiler.registerExpressionSyntax(reifySyntax);
                const disposeMatch = context.compiler.registerExpressionSyntax(matchSyntax);
                const disposeProjection = context.compiler.registerSourcePreprocessor({
                    id: "mltt-projection",
                    preprocess: projectDependentTypes,
                });
                const disposeAnalysis = context.compiler.registerProgramAnalyzer(dependentTypesAnalyzer);
                return () => {
                    disposeAnalysis();
                    disposeProjection();
                    disposeReify();
                    disposeMatch();
                };
            },
        },
        editor: {
            commands: [{ id: "tspp.showMlttNormalForms", title: "TS++: Show MLTT Normal Forms" }],
            grammars: ["./editor/dependent-types.tmLanguage.json"],
        },
    },
});

function getReifiedType(
    node: TSPPExtensionExpression,
    types: WeakMap<TSPPExtensionExpression, TSPPTypeNode>,
): TSPPTypeNode {
    const type = types.get(node) ?? node.extensionChildren[0];
    if (!type) throw new Error("Invalid dependent-type reify expression.");
    return type;
}

function getReifiedMatch(
    node: TSPPExtensionExpression,
    matches: WeakMap<TSPPExtensionExpression, {
        readonly scrutinee: TSPPExpression;
        readonly arms: readonly TSPPReifiedTypeMatchArm[];
    }>,
): { readonly scrutinee: TSPPExpression; readonly arms: readonly TSPPReifiedTypeMatchArm[]; } {
    const match = matches.get(node);
    if (!match) throw new Error("Invalid dependent-type match expression.");
    return match;
}

export {
    checkDependentTypeAnnotation,
    collectDependentTypeAliases,
    inferDependentTypeUniverse,
    parseDependentType,
    projectDependentTypes,
} from "./syntax";

export default dependentTypesPlugin;

