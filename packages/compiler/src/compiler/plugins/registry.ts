import {
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import type {
    TSPPCompilerHostAPI,
    TSPPDeclarationParser,
    TSPPDeclarationSyntax,
    TSPPDeclarationSyntaxKinds,
    TSPPExpressionParser,
    TSPPExpressionSyntax,
    TSPPExpressionSyntaxKinds,
    TSPPProgramAnalyzer,
    TSPPSourcePreprocessor,
} from "@tspp/plugin-sdk/compiler";
import { TSPPPluginHost } from "@tspp/plugin-sdk/host";

import { version } from "../corePublic.js";
import type {
    ExtensionExpression,
    Statement,
} from "../types.js";
import { SyntaxKind } from "../types.js";

const expressionSyntaxByPluginId = new Map<string, TSPPExpressionSyntax>();
const expressionSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPExpressionSyntax; }[]>();
const declarationSyntaxByPluginId = new Map<string, TSPPDeclarationSyntax>();
const declarationSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPDeclarationSyntax; }[]>();
const declarationSyntaxByNode = new WeakMap<object, TSPPDeclarationSyntax>();
const programAnalyzers = new Map<string, { pluginId: string; analyzer: TSPPProgramAnalyzer; }>();
const sourcePreprocessors = new Map<string, TSPPSourcePreprocessor>();
const projectedSources = new Map<string, { original: string; projected: string; }>();
let pluginHost: TSPPPluginHost | undefined;

const silentLogger: TSPPPluginLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

export const expressionSyntaxKinds: TSPPExpressionSyntaxKinds = {
    endOfFileToken: SyntaxKind.EndOfFileToken,
    identifier: SyntaxKind.Identifier,
    openBracketToken: SyntaxKind.OpenBracketToken,
    closeBracketToken: SyntaxKind.CloseBracketToken,
    openBraceToken: SyntaxKind.OpenBraceToken,
    closeBraceToken: SyntaxKind.CloseBraceToken,
    openParenToken: SyntaxKind.OpenParenToken,
    closeParenToken: SyntaxKind.CloseParenToken,
    semicolonToken: SyntaxKind.SemicolonToken,
    inKeyword: SyntaxKind.InKeyword,
    letKeyword: SyntaxKind.LetKeyword,
};

export const declarationSyntaxKinds: TSPPDeclarationSyntaxKinds = {
    identifier: SyntaxKind.Identifier,
    equalsToken: SyntaxKind.EqualsToken,
};

const compilerAPI: TSPPCompilerHostAPI = {
    expressionSyntaxKinds,
    declarationSyntaxKinds,
    registerExpressionSyntax(pluginId, syntax) {
        if (expressionSyntaxByPluginId.has(pluginId)) {
            throw new Error(`TSPP plugin '${pluginId}' registered expression syntax more than once.`);
        }
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP expression plugin '${pluginId}' must claim at least one start token.`);
        }

        const registration = { pluginId, syntax };
        expressionSyntaxByPluginId.set(pluginId, syntax);
        for (const token of syntax.startTokens) {
            const candidates = expressionSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else expressionSyntaxByStartToken.set(token, [registration]);
        }

        return () => {
            expressionSyntaxByPluginId.delete(pluginId);
            for (const token of syntax.startTokens) {
                const candidates = expressionSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) expressionSyntaxByStartToken.delete(token);
            }
        };
    },
    registerDeclarationSyntax(pluginId, syntax) {
        if (declarationSyntaxByPluginId.has(pluginId)) {
            throw new Error(`TSPP plugin '${pluginId}' registered declaration syntax more than once.`);
        }
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP declaration plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        declarationSyntaxByPluginId.set(pluginId, syntax);
        for (const token of syntax.startTokens) {
            const candidates = declarationSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else declarationSyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            declarationSyntaxByPluginId.delete(pluginId);
            for (const token of syntax.startTokens) {
                const candidates = declarationSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) declarationSyntaxByStartToken.delete(token);
            }
        };
    },
    registerProgramAnalyzer(pluginId, analyzer) {
        const key = `${pluginId}/${analyzer.id}`;
        if (programAnalyzers.has(key)) throw new Error(`Duplicate TSPP program analyzer '${key}'.`);
        programAnalyzers.set(key, { pluginId, analyzer });
        return () => programAnalyzers.delete(key);
    },
    registerSourcePreprocessor(pluginId, preprocessor) {
        const key = `${pluginId}/${preprocessor.id}`;
        if (sourcePreprocessors.has(key)) throw new Error(`Duplicate TSPP source preprocessor '${key}'.`);
        sourcePreprocessors.set(key, preprocessor);
        return () => sourcePreprocessors.delete(key);
    },
};

/** @internal */
export function initializeTSPPCompilerPlugins(compilerVersion: string): void {
    if (pluginHost) return;
    pluginHost = new TSPPPluginHost({ compilerVersion, logger: silentLogger, compiler: compilerAPI });
    pluginHost.activateAll();
}

/** Registers the compiler facet of a feature package for this process. */
export function registerTSPPCompilerPlugin(plugin: TSPPPlugin): boolean {
    initializeTSPPCompilerPlugins(version);
    const existing = pluginHost!.list().find(manifest => manifest.id === plugin.manifest.id);
    if (existing) {
        if (existing.version !== plugin.manifest.version || existing.apiVersion !== plugin.manifest.apiVersion) {
            throw new Error(
                `TSPP plugin '${plugin.manifest.id}' is already active at version ${existing.version}; cannot activate ${plugin.manifest.version}.`,
            );
        }
        return false;
    }
    pluginHost!.registerAndActivate(plugin);
    return true;
}

/** Extracts a feature capsule from either CommonJS or ESM-shaped package exports. */
export function getTSPPPluginFromModule(moduleValue: unknown): TSPPPlugin | undefined {
    if (!moduleValue || typeof moduleValue !== "object") return undefined;
    const exports = moduleValue as { default?: unknown; };
    const candidate = exports.default ?? moduleValue;
    if (!candidate || typeof candidate !== "object") return undefined;
    const plugin = candidate as Partial<TSPPPlugin>;
    return plugin.manifest && plugin.facets && typeof plugin.facets === "object"
        ? plugin as TSPPPlugin
        : undefined;
}

/** @internal */
export function tryParseExtensionExpression(
    token: SyntaxKind,
    createParser: (pluginId: string) => TSPPExpressionParser,
): ExtensionExpression | undefined {
    const candidates = expressionSyntaxByStartToken.get(token);
    if (!candidates) return undefined;

    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(parser) as ExtensionExpression;
    }
    return undefined;
}

/** @internal */
export function getExtensionExpressionSyntax(node: ExtensionExpression): TSPPExpressionSyntax {
    const syntax = expressionSyntaxByPluginId.get(node.pluginId);
    if (!syntax) throw new Error(`Unknown TSPP extension expression plugin: ${node.pluginId}`);
    return syntax;
}

/** @internal */
export function tryParseExtensionDeclaration(
    token: SyntaxKind,
    createParser: (pluginId: string) => TSPPDeclarationParser,
): Statement | undefined {
    const candidates = declarationSyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (!syntax.isStart(parser)) continue;
        const declaration = syntax.parse(parser) as Statement;
        declarationSyntaxByNode.set(declaration, syntax);
        return declaration;
    }
    return undefined;
}

/** @internal */
export function getExtensionDeclarationSyntax(node: object): TSPPDeclarationSyntax | undefined {
    return declarationSyntaxByNode.get(node);
}

/** Exposed for architecture tests and diagnostics. */
export function getRegisteredExpressionPluginIds(): readonly string[] {
    return [...expressionSyntaxByPluginId.keys()];
}

/** @internal */
export function getRegisteredTSPPProgramAnalyzers(): readonly TSPPProgramAnalyzer[] {
    return [...programAnalyzers.values()].map(registration => registration.analyzer);
}

/** Applies length-preserving feature projections before the upstream parser sees a file. @internal */
export function projectTSPPSource(fileName: string, sourceText: string): string {
    const existing = projectedSources.get(fileName);
    if (existing?.projected === sourceText) return sourceText;
    let projected = sourceText;
    for (const preprocessor of sourcePreprocessors.values()) {
        const next = preprocessor.preprocess(fileName, projected);
        if (next.length !== projected.length) {
            throw new Error(`TSPP source preprocessor '${preprocessor.id}' changed the source length.`);
        }
        for (let index = 0; index < next.length; index++) {
            if ((next.charCodeAt(index) === 10 || next.charCodeAt(index) === 13) !== (projected.charCodeAt(index) === 10 || projected.charCodeAt(index) === 13)) {
                throw new Error(`TSPP source preprocessor '${preprocessor.id}' changed line breaks.`);
            }
        }
        projected = next;
    }
    if (projected !== sourceText) projectedSources.set(fileName, { original: sourceText, projected });
    else projectedSources.delete(fileName);
    return projected;
}

/** Recovers the user-authored text corresponding to a projected parse tree. @internal */
export function getOriginalTSPPSource(fileName: string, projected: string): string {
    const entry = projectedSources.get(fileName);
    return entry?.projected === projected ? entry.original : projected;
}

// Initialize an empty process-level host. Project configuration supplies the
// feature capsules before source files are parsed.
initializeTSPPCompilerPlugins(version);
