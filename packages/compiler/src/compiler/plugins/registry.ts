import {
    TSPP_PLUGIN_API_VERSION,
    type TSPPCompilerHostAPI,
    type TSPPExpressionParser,
    type TSPPExpressionSyntax,
    type TSPPExpressionSyntaxKinds,
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import { TSPPPluginHost } from "@tspp/plugin-sdk/host";
import { letInExpressionPlugin } from "@tspp/plugin-let-in-expression";

import { version } from "../corePublic.js";
import type { ExtensionExpression } from "../types.js";
import { SyntaxKind } from "../types.js";

/** The single static compiler/plugin composition point. */
const compilerPlugins: readonly TSPPPlugin[] = [
    letInExpressionPlugin,
];

const expressionSyntaxByPluginId = new Map<string, TSPPExpressionSyntax>();
const expressionSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPExpressionSyntax; }[]>();
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

const compilerAPI: TSPPCompilerHostAPI = {
    expressionSyntaxKinds,
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
};

/** @internal */
export function initializeTSPPCompilerPlugins(compilerVersion: string): void {
    if (pluginHost) return;
    pluginHost = new TSPPPluginHost({ compilerVersion, logger: silentLogger, compiler: compilerAPI });
    for (const plugin of compilerPlugins) {
        if (plugin.manifest.apiVersion !== TSPP_PLUGIN_API_VERSION) {
            throw new Error(`TSPP compiler cannot load plugin '${plugin.manifest.id}' with API ${plugin.manifest.apiVersion}.`);
        }
        pluginHost.register(plugin);
    }
    pluginHost.activateAll();
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

/** Exposed for architecture tests and diagnostics. */
export function getRegisteredExpressionPluginIds(): readonly string[] {
    return [...expressionSyntaxByPluginId.keys()];
}

// The compiler namespace is also consumed directly by internal tools and the
// test runner, so static composition belongs here rather than only in CLI/API
// entry points. The public initializer remains idempotent.
initializeTSPPCompilerPlugins(version);
