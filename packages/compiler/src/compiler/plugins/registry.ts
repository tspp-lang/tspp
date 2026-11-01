import {
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import type {
    TSPPCompilerHostAPI,
    TSPPDeclarationSyntax,
    TSPPDeepReadonlyBindingSyntax,
    TSPPExpressionSyntax,
    TSPPFunctionBodySyntax,
    TSPPInterfaceMemberContract,
    TSPPKindAnnotationSyntax,
    TSPPPlaceholderExpressionSyntax,
    TSPPPostfixTypeSyntax,
    TSPPPreprocessedTypeAlias,
    TSPPProgramAnalyzer,
    TSPPSourcePreprocessor,
    TSPPTrailingClosureBindingSyntax,
    TSPPTypeKind,
    TSPPTypeSyntax,
} from "@tspp/plugin-sdk/compiler";
import { TSPPPluginHost } from "@tspp/plugin-sdk/host";
import type {
    TSPPLanguageServiceHostAPI,
    TSPPQuickInfoProvider,
} from "@tspp/plugin-sdk/language-service";

import { version } from "../corePublic.js";
import type {
    Block,
    Expression,
    ExtensionExpression,
    Statement,
    VariableDeclaration,
    VariableStatement,
} from "../types.js";
import {
    SyntaxKind,
    TransformFlags,
} from "../types.js";
import { getTaggedUnionSyntheticDeclarations } from "./taggedUnion.js";

const expressionSyntaxByPluginId = new Map<string, TSPPExpressionSyntax[]>();
const expressionSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPExpressionSyntax; }[]>();
const expressionSyntaxByNode = new WeakMap<object, TSPPExpressionSyntax>();
const functionBodySyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPFunctionBodySyntax; }[]>();
const functionBodySyntaxByBlock = new WeakMap<object, TSPPFunctionBodySyntax>();
const trailingClosureSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPTrailingClosureBindingSyntax; }[]>();
const trailingClosureBindingByStatement = new WeakMap<object, TrailingClosureBindingData>();
const deepReadonlySyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPDeepReadonlyBindingSyntax; }[]>();
const deepReadonlyStatements = new WeakSet<object>();
const selectedExtensionExpressions = new WeakMap<object, object>();
const declarationSyntaxByPluginId = new Map<string, TSPPDeclarationSyntax[]>();
const declarationSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPDeclarationSyntax; }[]>();
const declarationSyntaxByNode = new WeakMap<object, TSPPDeclarationSyntax>();
const typeSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPTypeSyntax; }[]>();
const postfixTypeSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPPostfixTypeSyntax; }[]>();
const typeConstructors = new WeakSet<object>();
const typeUniverseLevels = new WeakMap<object, number>();
const typeApplications = new WeakMap<object, { readonly target: object; readonly typeArguments: readonly object[]; }>();
const kindSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPKindAnnotationSyntax; }[]>();
const kindAnnotations = new WeakMap<object, TSPPTypeKind>();
const interfaceMemberContracts = new Map<string, TSPPInterfaceMemberContract>();
const programAnalyzers = new Map<string, { pluginId: string; analyzer: TSPPProgramAnalyzer; }>();
const placeholderExpressionSyntaxes = new Map<string, TSPPPlaceholderExpressionSyntax>();
const sourcePreprocessors = new Map<string, TSPPSourcePreprocessor>();
const compileTimeMacroPlugins = new Set<string>();
const quickInfoProviders = new Map<string, TSPPQuickInfoProvider>();
const projectedSources = new Map<string, { original: string; projected: string; }>();
let pluginHost: TSPPPluginHost | undefined;

const silentLogger: TSPPPluginLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

/** @internal */
export const expressionSyntaxKinds: {
    readonly endOfFileToken: SyntaxKind;
    readonly identifier: SyntaxKind;
    readonly openBracketToken: SyntaxKind;
    readonly closeBracketToken: SyntaxKind;
    readonly openBraceToken: SyntaxKind;
    readonly closeBraceToken: SyntaxKind;
    readonly openParenToken: SyntaxKind;
    readonly closeParenToken: SyntaxKind;
    readonly semicolonToken: SyntaxKind;
    readonly commaToken: SyntaxKind;
    readonly equalsToken: SyntaxKind;
    readonly colonToken: SyntaxKind;
    readonly lessThanToken: SyntaxKind;
    readonly minusToken: SyntaxKind;
    readonly equalsGreaterThanToken: SyntaxKind;
    readonly inKeyword: SyntaxKind;
    readonly letKeyword: SyntaxKind;
    readonly doKeyword: SyntaxKind;
    readonly whileKeyword: SyntaxKind;
} = {
    endOfFileToken: SyntaxKind.EndOfFileToken,
    identifier: SyntaxKind.Identifier,
    openBracketToken: SyntaxKind.OpenBracketToken,
    closeBracketToken: SyntaxKind.CloseBracketToken,
    openBraceToken: SyntaxKind.OpenBraceToken,
    closeBraceToken: SyntaxKind.CloseBraceToken,
    openParenToken: SyntaxKind.OpenParenToken,
    closeParenToken: SyntaxKind.CloseParenToken,
    semicolonToken: SyntaxKind.SemicolonToken,
    commaToken: SyntaxKind.CommaToken,
    equalsToken: SyntaxKind.EqualsToken,
    colonToken: SyntaxKind.ColonToken,
    lessThanToken: SyntaxKind.LessThanToken,
    minusToken: SyntaxKind.MinusToken,
    equalsGreaterThanToken: SyntaxKind.EqualsGreaterThanToken,
    inKeyword: SyntaxKind.InKeyword,
    letKeyword: SyntaxKind.LetKeyword,
    doKeyword: SyntaxKind.DoKeyword,
    whileKeyword: SyntaxKind.WhileKeyword,
};

/** @internal */
export const declarationSyntaxKinds: {
    readonly identifier: SyntaxKind;
    readonly equalsToken: SyntaxKind;
    readonly barToken: SyntaxKind;
    readonly openParenToken: SyntaxKind;
    readonly closeParenToken: SyntaxKind;
    readonly commaToken: SyntaxKind;
    readonly colonToken: SyntaxKind;
} = {
    identifier: SyntaxKind.Identifier,
    equalsToken: SyntaxKind.EqualsToken,
    barToken: SyntaxKind.BarToken,
    openParenToken: SyntaxKind.OpenParenToken,
    closeParenToken: SyntaxKind.CloseParenToken,
    commaToken: SyntaxKind.CommaToken,
    colonToken: SyntaxKind.ColonToken,
};

/** @internal */
export const typeSyntaxKinds: {
    readonly endOfFileToken: SyntaxKind;
    readonly identifier: SyntaxKind;
    readonly letKeyword: SyntaxKind;
    readonly inKeyword: SyntaxKind;
    readonly inferKeyword: SyntaxKind;
    readonly lessThanToken: SyntaxKind;
    readonly greaterThanToken: SyntaxKind;
    readonly equalsToken: SyntaxKind;
    readonly equalsGreaterThanToken: SyntaxKind;
    readonly openBraceToken: SyntaxKind;
    readonly closeBraceToken: SyntaxKind;
    readonly colonToken: SyntaxKind;
    readonly commaToken: SyntaxKind;
    readonly semicolonToken: SyntaxKind;
    readonly openParenToken: SyntaxKind;
    readonly closeParenToken: SyntaxKind;
} = {
    endOfFileToken: SyntaxKind.EndOfFileToken,
    identifier: SyntaxKind.Identifier,
    letKeyword: SyntaxKind.LetKeyword,
    inKeyword: SyntaxKind.InKeyword,
    inferKeyword: SyntaxKind.InferKeyword,
    lessThanToken: SyntaxKind.LessThanToken,
    greaterThanToken: SyntaxKind.GreaterThanToken,
    equalsToken: SyntaxKind.EqualsToken,
    equalsGreaterThanToken: SyntaxKind.EqualsGreaterThanToken,
    openBraceToken: SyntaxKind.OpenBraceToken,
    closeBraceToken: SyntaxKind.CloseBraceToken,
    colonToken: SyntaxKind.ColonToken,
    commaToken: SyntaxKind.CommaToken,
    semicolonToken: SyntaxKind.SemicolonToken,
    openParenToken: SyntaxKind.OpenParenToken,
    closeParenToken: SyntaxKind.CloseParenToken,
};

const compilerAPI: TSPPCompilerHostAPI = {
    expressionSyntaxKinds,
    declarationSyntaxKinds,
    typeSyntaxKinds,
    registerExpressionSyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP expression plugin '${pluginId}' must claim at least one start token.`);
        }

        const registration = { pluginId, syntax };
        const syntaxes = expressionSyntaxByPluginId.get(pluginId);
        if (syntaxes) syntaxes.push(syntax);
        else expressionSyntaxByPluginId.set(pluginId, [syntax]);
        for (const token of syntax.startTokens) {
            const candidates = expressionSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else expressionSyntaxByStartToken.set(token, [registration]);
        }

        return () => {
            const syntaxes = expressionSyntaxByPluginId.get(pluginId);
            const syntaxIndex = syntaxes?.indexOf(syntax) ?? -1;
            if (syntaxes && syntaxIndex >= 0) syntaxes.splice(syntaxIndex, 1);
            if (syntaxes?.length === 0) expressionSyntaxByPluginId.delete(pluginId);
            for (const token of syntax.startTokens) {
                const candidates = expressionSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) expressionSyntaxByStartToken.delete(token);
            }
        };
    },
    registerFunctionBodySyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP function-body plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        for (const token of syntax.startTokens) {
            const candidates = functionBodySyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else functionBodySyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            for (const token of syntax.startTokens) {
                const candidates = functionBodySyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) functionBodySyntaxByStartToken.delete(token);
            }
        };
    },
    registerTrailingClosureBindingSyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP trailing-closure plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        for (const token of syntax.startTokens) {
            const candidates = trailingClosureSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else trailingClosureSyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            for (const token of syntax.startTokens) {
                const candidates = trailingClosureSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) trailingClosureSyntaxByStartToken.delete(token);
            }
        };
    },
    registerDeepReadonlyBindingSyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP deep-readonly plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        for (const token of syntax.startTokens) {
            const candidates = deepReadonlySyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else deepReadonlySyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            for (const token of syntax.startTokens) {
                const candidates = deepReadonlySyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) deepReadonlySyntaxByStartToken.delete(token);
            }
        };
    },
    registerDeclarationSyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP declaration plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        const syntaxes = declarationSyntaxByPluginId.get(pluginId);
        if (syntaxes) syntaxes.push(syntax);
        else declarationSyntaxByPluginId.set(pluginId, [syntax]);
        for (const token of syntax.startTokens) {
            const candidates = declarationSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else declarationSyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            const syntaxes = declarationSyntaxByPluginId.get(pluginId);
            const syntaxIndex = syntaxes?.indexOf(syntax) ?? -1;
            if (syntaxes && syntaxIndex >= 0) syntaxes.splice(syntaxIndex, 1);
            if (syntaxes?.length === 0) declarationSyntaxByPluginId.delete(pluginId);
            for (const token of syntax.startTokens) {
                const candidates = declarationSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) declarationSyntaxByStartToken.delete(token);
            }
        };
    },
    registerTypeSyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP type-syntax plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        for (const token of syntax.startTokens) {
            const candidates = typeSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else typeSyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            for (const token of syntax.startTokens) {
                const candidates = typeSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) typeSyntaxByStartToken.delete(token);
            }
        };
    },
    registerPostfixTypeSyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP postfix-type plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        for (const token of syntax.startTokens) {
            const candidates = postfixTypeSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else postfixTypeSyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            for (const token of syntax.startTokens) {
                const candidates = postfixTypeSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) postfixTypeSyntaxByStartToken.delete(token);
            }
        };
    },
    registerKindAnnotationSyntax(pluginId, syntax) {
        if (syntax.startTokens.length === 0) {
            throw new Error(`TSPP kind-annotation plugin '${pluginId}' must claim at least one start token.`);
        }
        const registration = { pluginId, syntax };
        for (const token of syntax.startTokens) {
            const candidates = kindSyntaxByStartToken.get(token);
            if (candidates) candidates.push(registration);
            else kindSyntaxByStartToken.set(token, [registration]);
        }
        return () => {
            for (const token of syntax.startTokens) {
                const candidates = kindSyntaxByStartToken.get(token);
                if (!candidates) continue;
                const index = candidates.indexOf(registration);
                if (index >= 0) candidates.splice(index, 1);
                if (candidates.length === 0) kindSyntaxByStartToken.delete(token);
            }
        };
    },
    registerInterfaceMemberContract(pluginId, contract) {
        if (interfaceMemberContracts.has(pluginId)) {
            throw new Error(`TSPP plugin '${pluginId}' registered an interface member contract more than once.`);
        }
        if ([...interfaceMemberContracts.values()].some(existing => existing.modifier === contract.modifier)) {
            throw new Error(`The interface member modifier '${contract.modifier}' is already claimed by another TSPP plugin.`);
        }
        interfaceMemberContracts.set(pluginId, contract);
        return () => interfaceMemberContracts.delete(pluginId);
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
    registerPlaceholderExpressionSyntax(pluginId, syntax) {
        if (!syntax.placeholder || syntax.placeholder !== syntax.placeholder.trim()) {
            throw new Error(`TSPP placeholder syntax from '${pluginId}' must use a non-empty identifier.`);
        }
        if (placeholderExpressionSyntaxes.size && !placeholderExpressionSyntaxes.has(pluginId)) {
            throw new Error("Only one TSPP placeholder expression syntax can be active at a time.");
        }
        placeholderExpressionSyntaxes.set(pluginId, syntax);
        return () => placeholderExpressionSyntaxes.delete(pluginId);
    },
    registerCompileTimeMacros(pluginId) {
        if (compileTimeMacroPlugins.size && !compileTimeMacroPlugins.has(pluginId)) {
            throw new Error(`Compile-time macros are already owned by TSPP plugin '${[...compileTimeMacroPlugins][0]}'.`);
        }
        compileTimeMacroPlugins.add(pluginId);
        return () => compileTimeMacroPlugins.delete(pluginId);
    },
};

const languageServiceAPI: TSPPLanguageServiceHostAPI = {
    registerQuickInfoProvider(pluginId, provider) {
        if (quickInfoProviders.has(pluginId)) {
            throw new Error(`TSPP plugin '${pluginId}' registered more than one quick-info provider.`);
        }
        quickInfoProviders.set(pluginId, provider);
        return () => quickInfoProviders.delete(pluginId);
    },
};

/** @internal */
export function hasCompileTimeMacros(): boolean {
    return compileTimeMacroPlugins.size > 0;
}

/** @internal */
export function initializeTSPPCompilerPlugins(compilerVersion: string): void {
    if (pluginHost) return;
    pluginHost = new TSPPPluginHost({
        compilerVersion,
        logger: silentLogger,
        compiler: compilerAPI,
        languageService: languageServiceAPI,
    });
    pluginHost.activateAll();
}

/** Registers the compiler facet of a feature package for this process. */
export function registerTSPPCompilerPlugin(plugin: unknown): boolean {
    const capsule = plugin as TSPPPlugin;
    initializeTSPPCompilerPlugins(version);
    const existing = pluginHost!.list().find(manifest => manifest.id === capsule.manifest.id);
    if (existing) {
        if (existing.version !== capsule.manifest.version || existing.apiVersion !== capsule.manifest.apiVersion) {
            throw new Error(
                `TSPP plugin '${capsule.manifest.id}' is already active at version ${existing.version}; cannot activate ${capsule.manifest.version}.`,
            );
        }
        return false;
    }
    pluginHost!.registerAndActivate(capsule);
    return true;
}

/** Extracts a feature capsule from either CommonJS or ESM-shaped package exports. @internal */
export function getTSPPPluginFromModule(moduleValue: unknown): any {
    if (!moduleValue || typeof moduleValue !== "object") return undefined;
    const exports = moduleValue as { default?: unknown; };
    const candidate = exports.default ?? moduleValue;
    if (!candidate || typeof candidate !== "object") return undefined;
    const plugin = candidate as Partial<TSPPPlugin>;
    return plugin.manifest && plugin.facets && typeof plugin.facets === "object"
        ? plugin as TSPPPlugin
        : undefined;
}

/** Public, compiler-neutral description of an active feature capsule. */
export interface TSPPPluginSummary {
    readonly id: string;
    readonly version: string;
    readonly apiVersion: number;
    readonly displayName?: string;
    readonly requires?: readonly string[];
    readonly optionalDependencies?: readonly string[];
    readonly conflicts?: readonly string[];
    readonly capabilities?: readonly string[];
}

export function getRegisteredTSPPPlugins(): readonly TSPPPluginSummary[] {
    initializeTSPPCompilerPlugins(version);
    return pluginHost!.list();
}

/** Applies every active feature projection and returns the TypeScript-compatible source. */
export function getTSPPProjectedSource(fileName: string, sourceText: string): string {
    return projectTSPPSource(fileName, sourceText);
}

/** @internal */
export function getTSPPQuickInfo(
    fileName: string,
    sourceText: string,
    position: number,
    context?: {
        readonly token?: { readonly start: number; readonly length: number; readonly text: string; };
        readonly semanticType?: string;
        readonly upstream?: { readonly display: string; readonly kind: string; };
    },
): { readonly start: number; readonly length: number; readonly display: string; readonly documentation?: string; } | undefined {
    for (const provider of quickInfoProviders.values()) {
        const result = provider({ fileName, sourceText, position, ...context });
        if (result) return result;
    }
    return undefined;
}

/** @internal */
export function hasInterfaceMemberContract(modifier: "static"): boolean {
    return [...interfaceMemberContracts.values()].some(contract => contract.modifier === modifier);
}

/** @internal */
export function getPlaceholderExpressionSyntax(): { readonly placeholder: string; } | undefined {
    return placeholderExpressionSyntaxes.values().next().value;
}

/** @internal */
export function tryParseExtensionExpression(
    token: SyntaxKind,
    createParser: (pluginId: string) => any,
): Expression | undefined {
    const candidates = expressionSyntaxByStartToken.get(token);
    if (!candidates) return undefined;

    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) {
            const expression = syntax.parse(parser) as Expression;
            expressionSyntaxByNode.set(expression, syntax);
            return expression;
        }
    }
    return undefined;
}

/** @internal */
export function tryParseExtensionType(
    token: SyntaxKind,
    createParser: (pluginId: string) => any,
): object | undefined {
    const candidates = typeSyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(parser);
    }
    return undefined;
}

/** @internal */
export function registerTypeConstructor(node: object): void {
    typeConstructors.add(node);
}

/** @internal */
export function registerTypeUniverse(node: object, level: number): void {
    typeUniverseLevels.set(node, level);
}

/** @internal */
export function registerTypeApplication(node: object, target: object, typeArguments: readonly object[]): void {
    typeApplications.set(node, { target, typeArguments });
}

/** @internal */
export function getTypeApplication(node: object): { readonly target: object; readonly typeArguments: readonly object[]; } | undefined {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const application = typeApplications.get(current);
        if (application) return application;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export function tryParsePostfixType(
    token: SyntaxKind,
    target: object,
    createParser: (pluginId: string) => any,
): object | undefined {
    const candidates = postfixTypeSyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(target, parser);
    }
    return undefined;
}

/** @internal */
export function getTypeUniverseLevel(node: object): number | undefined {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const level = typeUniverseLevels.get(current);
        if (level !== undefined) return level;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export function tryParseKindAnnotation(
    token: SyntaxKind,
    createParser: (pluginId: string) => any,
): any {
    const candidates = kindSyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(parser);
    }
    return undefined;
}

/** @internal */
export function setTypeKindAnnotation(node: object, kind: any): void {
    if (kind) kindAnnotations.set(node, kind);
}

/** @internal */
export function getTypeKindAnnotation(node: object): any {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const kind = kindAnnotations.get(current);
        if (kind) return kind;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export function isExtensionTypeConstructor(node: object): boolean {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        if (typeConstructors.has(current)) return true;
        current = current.original;
    }
    return false;
}

/** @internal */
export function getExtensionExpressionSyntax(node: ExtensionExpression): any {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const syntax = expressionSyntaxByNode.get(current);
        if (syntax) return syntax;
        current = current.original;
    }
    const syntaxes = expressionSyntaxByPluginId.get(node.pluginId);
    if (syntaxes?.length === 1) return syntaxes[0];
    throw new Error(`Unknown TSPP extension expression syntax for plugin: ${node.pluginId}`);
}

/** @internal */
export function tryParseExtensionFunctionBody(
    token: SyntaxKind,
    createParser: () => any,
): Block | undefined {
    const candidates = functionBodySyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { syntax } of candidates) {
        const parser = createParser();
        if (!syntax.isStart(parser)) continue;
        const block = syntax.parse(parser) as Block;
        (block as { transformFlags: TransformFlags; }).transformFlags |= TransformFlags.ContainsTypeScript;
        functionBodySyntaxByBlock.set(block, syntax);
        return block;
    }
    return undefined;
}

/** @internal */
export function getExtensionFunctionBodySyntax(block: object): any {
    let current: { readonly original?: object; } | undefined = block;
    while (current) {
        const syntax = functionBodySyntaxByBlock.get(current);
        if (syntax) return syntax;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export interface TrailingClosureBindingData {
    readonly statement: VariableStatement;
    readonly declaration: VariableDeclaration;
    readonly target: Expression;
}

/** @internal */
export function tryParseTrailingClosureBinding(
    token: SyntaxKind,
    createParser: (pluginId: string) => any,
): Statement | undefined {
    const candidates = trailingClosureSyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(parser) as Statement;
    }
    return undefined;
}

/** @internal */
export function registerTrailingClosureBinding(
    statement: VariableStatement,
    declaration: VariableDeclaration,
    target: Expression,
): void {
    trailingClosureBindingByStatement.set(statement, { statement, declaration, target });
}

/** @internal */
export function getTrailingClosureBinding(node: object): TrailingClosureBindingData | undefined {
    let current: { readonly parent?: object; readonly original?: object; } | undefined = node;
    while (current) {
        const data = trailingClosureBindingByStatement.get(current);
        if (data) return data;
        current = current.parent ?? current.original;
    }
    return undefined;
}

/** @internal */
export function tryParseDeepReadonlyBinding(
    token: SyntaxKind,
    createParser: (pluginId: string) => any,
): Statement | undefined {
    const candidates = deepReadonlySyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(parser) as Statement;
    }
    return undefined;
}

/** @internal */
export function registerDeepReadonlyBinding(statement: VariableStatement): void {
    deepReadonlyStatements.add(statement);
}

/** @internal */
export function isDeepReadonlyBinding(node: object): boolean {
    let current: { readonly parent?: object; readonly original?: object; } | undefined = node;
    while (current) {
        if (deepReadonlyStatements.has(current)) return true;
        current = current.parent ?? current.original;
    }
    return false;
}

/** @internal */
export function setSelectedExtensionExpression(owner: object, expression: object): void {
    selectedExtensionExpressions.set(owner, expression);
}

/** @internal */
export function getSelectedExtensionExpression(owner: object): object | undefined {
    let current: { readonly original?: object; } | undefined = owner;
    while (current) {
        const selected = selectedExtensionExpressions.get(current);
        if (selected) return selected;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export function isStartOfExtensionDeclaration(
    token: SyntaxKind,
    createParser: (pluginId: string) => any,
): boolean {
    const candidates = declarationSyntaxByStartToken.get(token);
    if (!candidates) return false;
    return candidates.some(({ pluginId, syntax }) => syntax.isStart(createParser(pluginId)));
}

/** @internal */
export function tryParseExtensionDeclaration(
    token: SyntaxKind,
    createParser: (pluginId: string) => any,
): Statement | undefined {
    const candidates = declarationSyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (!syntax.isStart(parser)) continue;
        const declaration = syntax.parse(parser) as Statement;
        declarationSyntaxByNode.set(declaration, syntax);
        for (const synthetic of getTaggedUnionSyntheticDeclarations(declaration)) {
            declarationSyntaxByNode.set(synthetic, syntax);
        }
        return declaration;
    }
    return undefined;
}

/** @internal */
export function getExtensionDeclarationSyntax(node: object): any {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const syntax = declarationSyntaxByNode.get(current);
        if (syntax) return syntax;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export function hasExtensionDeclarationCallTransforms(): boolean {
    for (const syntaxes of declarationSyntaxByPluginId.values()) {
        if (syntaxes.some(syntax => syntax.transformCall)) return true;
    }
    return false;
}

/** @internal */
export function hasExtensionDeclarationValueUseRestrictions(): boolean {
    for (const syntaxes of declarationSyntaxByPluginId.values()) {
        if (syntaxes.some(syntax => syntax.valueUse === "call-only")) return true;
    }
    return false;
}

/** Exposed for architecture tests and diagnostics. @internal */
export function getRegisteredExpressionPluginIds(): readonly string[] {
    return [...expressionSyntaxByPluginId.keys()];
}

/** @internal */
export function getRegisteredTSPPProgramAnalyzers(): readonly any[] {
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

/** Restores plugin-owned type syntax for feature-rich declaration emit. @internal */
export function getPreprocessedTypeAliasDeclaration(
    fileName: string,
    name: string,
    declarationStart: number,
): TSPPPreprocessedTypeAlias | undefined {
    const entry = projectedSources.get(fileName);
    if (!entry) return undefined;
    for (const preprocessor of sourcePreprocessors.values()) {
        const restored = preprocessor.restoreTypeAliasDeclaration?.({
            fileName,
            sourceText: entry.original,
            name,
            declarationStart,
        });
        if (restored) return restored;
    }
    return undefined;
}

// Initialize an empty process-level host. Project configuration supplies the
// feature capsules before source files are parsed.
initializeTSPPCompilerPlugins(version);
