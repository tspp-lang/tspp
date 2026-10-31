import {
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import type {
    TSPPCompilerHostAPI,
    TSPPDeclarationParser,
    TSPPDeclarationSyntax,
    TSPPDeclarationSyntaxKinds,
    TSPPDeepReadonlyBindingParser,
    TSPPDeepReadonlyBindingSyntax,
    TSPPExpressionParser,
    TSPPExpressionSyntax,
    TSPPExpressionSyntaxKinds,
    TSPPFunctionBodyParser,
    TSPPFunctionBodySyntax,
    TSPPKindAnnotationParser,
    TSPPKindAnnotationSyntax,
    TSPPInterfaceMemberContract,
    TSPPPostfixTypeParser,
    TSPPPostfixTypeSyntax,
    TSPPStatementParser,
    TSPPTrailingClosureBindingSyntax,
    TSPPTypeParser,
    TSPPTypeSyntax,
    TSPPTypeSyntaxKinds,
    TSPPTypeKind,
    TSPPProgramAnalyzer,
    TSPPSourcePreprocessor,
} from "@tspp/plugin-sdk/compiler";
import { TSPPPluginHost } from "@tspp/plugin-sdk/host";

import { version } from "../corePublic.js";
import type {
    Block,
    Expression,
    ExtensionExpression,
    Statement,
    VariableDeclaration,
    VariableStatement,
} from "../types.js";
import { SyntaxKind, TransformFlags } from "../types.js";
import { getTaggedUnionSyntheticDeclarations } from "./taggedUnion.js";

const expressionSyntaxByPluginId = new Map<string, TSPPExpressionSyntax>();
const expressionSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPExpressionSyntax; }[]>();
const functionBodySyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPFunctionBodySyntax; }[]>();
const functionBodySyntaxByBlock = new WeakMap<object, TSPPFunctionBodySyntax>();
const trailingClosureSyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPTrailingClosureBindingSyntax; }[]>();
const trailingClosureBindingByStatement = new WeakMap<object, TrailingClosureBindingData>();
const deepReadonlySyntaxByStartToken = new Map<number, { pluginId: string; syntax: TSPPDeepReadonlyBindingSyntax; }[]>();
const deepReadonlyStatements = new WeakSet<object>();
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

export const declarationSyntaxKinds: TSPPDeclarationSyntaxKinds = {
    identifier: SyntaxKind.Identifier,
    equalsToken: SyntaxKind.EqualsToken,
    barToken: SyntaxKind.BarToken,
    openParenToken: SyntaxKind.OpenParenToken,
    closeParenToken: SyntaxKind.CloseParenToken,
    commaToken: SyntaxKind.CommaToken,
    colonToken: SyntaxKind.ColonToken,
};

export const typeSyntaxKinds: TSPPTypeSyntaxKinds = {
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
export function hasInterfaceMemberContract(modifier: TSPPInterfaceMemberContract["modifier"]): boolean {
    return [...interfaceMemberContracts.values()].some(contract => contract.modifier === modifier);
}

/** @internal */
export function tryParseExtensionExpression(
    token: SyntaxKind,
    createParser: (pluginId: string) => TSPPExpressionParser,
): Expression | undefined {
    const candidates = expressionSyntaxByStartToken.get(token);
    if (!candidates) return undefined;

    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(parser) as Expression;
    }
    return undefined;
}

/** @internal */
export function tryParseExtensionType(
    token: SyntaxKind,
    createParser: (pluginId: string) => TSPPTypeParser,
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
    createParser: (pluginId: string) => TSPPPostfixTypeParser,
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
    createParser: (pluginId: string) => TSPPKindAnnotationParser,
): TSPPTypeKind | undefined {
    const candidates = kindSyntaxByStartToken.get(token);
    if (!candidates) return undefined;
    for (const { pluginId, syntax } of candidates) {
        const parser = createParser(pluginId);
        if (syntax.isStart(parser)) return syntax.parse(parser);
    }
    return undefined;
}

/** @internal */
export function setTypeKindAnnotation(node: object, kind: TSPPTypeKind | undefined): void {
    if (kind) kindAnnotations.set(node, kind);
}

/** @internal */
export function getTypeKindAnnotation(node: object): TSPPTypeKind | undefined {
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
export function getExtensionExpressionSyntax(node: ExtensionExpression): TSPPExpressionSyntax {
    const syntax = expressionSyntaxByPluginId.get(node.pluginId);
    if (!syntax) throw new Error(`Unknown TSPP extension expression plugin: ${node.pluginId}`);
    return syntax;
}

/** @internal */
export function tryParseExtensionFunctionBody(
    token: SyntaxKind,
    createParser: () => TSPPFunctionBodyParser,
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
export function getExtensionFunctionBodySyntax(block: object): TSPPFunctionBodySyntax | undefined {
    let current: { readonly original?: object; } | undefined = block;
    while (current) {
        const syntax = functionBodySyntaxByBlock.get(current);
        if (syntax) return syntax;
        current = current.original;
    }
    return undefined;
}

export interface TrailingClosureBindingData {
    readonly statement: VariableStatement;
    readonly declaration: VariableDeclaration;
    readonly target: Expression;
}

/** @internal */
export function tryParseTrailingClosureBinding(
    token: SyntaxKind,
    createParser: (pluginId: string) => TSPPStatementParser,
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
    createParser: (pluginId: string) => TSPPDeepReadonlyBindingParser,
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
export function isStartOfExtensionDeclaration(
    token: SyntaxKind,
    createParser: (pluginId: string) => TSPPDeclarationParser,
): boolean {
    const candidates = declarationSyntaxByStartToken.get(token);
    if (!candidates) return false;
    return candidates.some(({ pluginId, syntax }) => syntax.isStart(createParser(pluginId)));
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
        for (const synthetic of getTaggedUnionSyntheticDeclarations(declaration)) {
            declarationSyntaxByNode.set(synthetic, syntax);
        }
        return declaration;
    }
    return undefined;
}

/** @internal */
export function getExtensionDeclarationSyntax(node: object): TSPPDeclarationSyntax | undefined {
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
