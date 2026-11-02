import {
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import type {
    TSPPCompilerHostAPI,
    TSPPDiagnosticProvider,
    TSPPExpressionRewriter,
    TSPPInterfaceMemberContract,
    TSPPPreprocessedTypeAlias,
    TSPPProgramAnalyzer,
    TSPPProgramRebuilder,
    TSPPSourcePreprocessor,
    TSPPSyntaxAnnotation,
    TSPPSyntaxCursor,
    TSPPSyntaxExtension,
    TSPPSyntaxExtensionPosition,
    TSPPTypeExtension,
    TSPPTypeScript,
} from "@tspp/plugin-sdk/compiler";
import { TSPPPluginHost } from "@tspp/plugin-sdk/host";
import type {
    TSPPLanguageServiceHostAPI,
    TSPPQuickInfoProvider,
} from "@tspp/plugin-sdk/language-service";

import * as ts from "../_namespaces/ts.js";
import { version } from "../corePublic.js";
import type {
    Diagnostic,
    Expression,
    Identifier,
    Node,
    NodeFactory,
    SourceFile,
    TypeChecker,
} from "../types.js";
import { SyntaxKind } from "../types.js";

const interfaceMemberContracts = new Map<string, TSPPInterfaceMemberContract>();
const programAnalyzers = new Map<string, { pluginId: string; analyzer: TSPPProgramAnalyzer; }>();
const expressionRewriters = new Map<string, TSPPExpressionRewriter>();
const sourcePreprocessors = new Map<string, TSPPSourcePreprocessor>();
const programRebuilders = new Map<string, TSPPProgramRebuilder>();
const syntaxExtensions = new Map<TSPPSyntaxExtensionPosition, { pluginId: string; extension: TSPPSyntaxExtension; }[]>();
const diagnosticProviders = new Map<string, TSPPDiagnosticProvider>();
const typeExtensions = new Map<string, TSPPTypeExtension>();
const typeExtensionList: TSPPTypeExtension[] = [];
const syntaxNodes = new WeakSet<Node>();
const additionalListElements = new WeakMap<Node, readonly Node[]>();
const quickInfoProviders = new Map<string, TSPPQuickInfoProvider>();
const projectedSources = new Map<string, { original: string; projected: string; }>();
let pluginHost: TSPPPluginHost | undefined;

const silentLogger: TSPPPluginLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

const compilerAPI: TSPPCompilerHostAPI = {
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
    registerExpressionRewriter(pluginId, rewriter) {
        if (expressionRewriters.has(pluginId)) throw new Error(`TSPP plugin '${pluginId}' already registered an expression rewriter.`);
        expressionRewriters.set(pluginId, rewriter);
        return () => expressionRewriters.delete(pluginId);
    },
    registerSyntaxExtension(pluginId, extension) {
        const entry = { pluginId, extension };
        const list = syntaxExtensions.get(extension.position) ?? [];
        list.push(entry);
        syntaxExtensions.set(extension.position, list);
        return () => {
            const index = list.indexOf(entry);
            if (index >= 0) list.splice(index, 1);
        };
    },
    registerDiagnosticProvider(pluginId, provider) {
        const key = `${pluginId}/${provider.id}`;
        if (diagnosticProviders.has(key)) throw new Error(`Duplicate TSPP diagnostic provider '${key}'.`);
        diagnosticProviders.set(key, provider);
        return () => diagnosticProviders.delete(key);
    },
    registerTypeExtension(pluginId, extension) {
        if (typeExtensions.has(pluginId)) throw new Error(`TSPP plugin '${pluginId}' registered more than one type extension.`);
        typeExtensions.set(pluginId, extension);
        typeExtensionList.push(extension);
        return () => {
            typeExtensions.delete(pluginId);
            typeExtensionList.splice(typeExtensionList.indexOf(extension), 1);
        };
    },
    registerProgramRebuilder(pluginId, rebuilder) {
        const key = `${pluginId}/${rebuilder.id}`;
        if (programRebuilders.has(key)) throw new Error(`Duplicate TSPP program rebuilder '${key}'.`);
        programRebuilders.set(key, rebuilder);
        return () => programRebuilders.delete(key);
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

/** Lets plugin syntax registered for `position` parse at the current token, if one starts there. @internal */
export function tryParseTSPPSyntax(position: TSPPSyntaxExtensionPosition, token: SyntaxKind, createCursor: () => TSPPSyntaxCursor): Node | undefined {
    const candidates = syntaxExtensions.get(position);
    if (!candidates?.length) return undefined;
    let cursor: TSPPSyntaxCursor | undefined;
    for (const { extension } of candidates) {
        if (!(extension.startTokens as readonly number[]).includes(token)) continue;
        cursor ??= createCursor();
        if (!extension.isStart(cursor)) continue;
        const parsed = extension.parse(cursor) as unknown as Node | readonly Node[];
        const [first, ...rest] = Array.isArray(parsed) ? parsed : [parsed];
        syntaxNodes.add(first);
        if (rest.length) additionalListElements.set(first, rest);
        return first;
    }
    return undefined;
}

/** Whether plugin syntax registered for `position` starts at the current token; callers look ahead. @internal */
export function isStartOfTSPPSyntax(position: TSPPSyntaxExtensionPosition, token: SyntaxKind, createCursor: () => TSPPSyntaxCursor): boolean {
    const candidates = syntaxExtensions.get(position);
    if (!candidates?.length) return false;
    const cursor = createCursor();
    return candidates.some(({ extension }) => (extension.startTokens as readonly number[]).includes(token) && extension.isStart(cursor));
}

/** A list element followed by the other statements its plugin syntax stands for. @internal */
export function expandTSPPListElement<T extends Node>(node: T): readonly T[] {
    const rest = additionalListElements.get(node);
    if (!rest) return [node];
    for (const element of rest) syntaxNodes.add(element);
    return [node, ...rest as readonly T[]];
}

/** Hands a finished declaration to the plugin annotation parsed inside it; the declaration is never reused. @internal */
export function annotateTSPPSyntax<T extends Node>(declaration: T, annotation: unknown): T {
    if (typeof annotation === "function") {
        (annotation as TSPPSyntaxAnnotation)(declaration as never);
        syntaxNodes.add(declaration);
    }
    return declaration;
}

/** Plugin syntax is parsed again rather than reused by incremental parsing, so it never reuses a partial result. @internal */
export function isTSPPSyntaxNode(node: Node): boolean {
    return syntaxNodes.has(node);
}

/**
 * The authored text a plugin restores for one of its nodes in feature-rich declaration output, or the text it gives
 * the node in the TypeScript-compatible declaration output. @internal
 */
export function getTSPPRestoredDeclaration(node: Node, compatibility?: boolean): string | undefined {
    for (const candidates of syntaxExtensions.values()) {
        for (const { extension } of candidates) {
            const restored = compatibility ? extension.restoreCompatibilityDeclaration?.(node as never) : extension.restoreDeclaration?.(node as never);
            if (restored !== undefined) return restored;
        }
    }
    return undefined;
}

/** A diagnostic as every provider's filter leaves it: undefined when one drops it, or the last replacement. */
function filterTSPPDiagnostic<T extends Diagnostic>(providers: readonly TSPPDiagnosticProvider[], diagnostic: T): T | undefined {
    let result = diagnostic;
    for (const provider of providers) {
        const filtered = provider.filterDiagnostic?.(result as never) ?? true;
        if (filtered === false) return undefined;
        if (filtered !== true) result = filtered as unknown as T;
    }
    return result;
}

/** Diagnostics as plugins filter them, such as suggestions about code a plugin generated. @internal */
export function filterTSPPDiagnostics<T extends Diagnostic>(diagnostics: readonly T[]): readonly T[] {
    if (!diagnosticProviders.size) return diagnostics;
    const providers = [...diagnosticProviders.values()];
    return ts.mapDefined(diagnostics, diagnostic => filterTSPPDiagnostic(providers, diagnostic));
}

/** A source file's check diagnostics as plugins filter them, followed by the diagnostics plugins add. @internal */
export function applyTSPPSemanticDiagnostics(sourceFile: SourceFile, checker: TypeChecker, diagnostics: Diagnostic[]): Diagnostic[] {
    if (!diagnosticProviders.size) return diagnostics;
    const providers = [...diagnosticProviders.values()];
    const result = ts.mapDefined(diagnostics, diagnostic => filterTSPPDiagnostic(providers, diagnostic));
    for (const provider of providers) {
        result.push(...provider.getSemanticDiagnostics(sourceFile as never, checker as never) as unknown as readonly Diagnostic[]);
    }
    return result;
}

/** A member that an interface member contract moves to the implementing side, such as `static` in an interface. @internal */
export function isTSPPInterfaceStaticMember(node: Node): boolean {
    return hasInterfaceMemberContract("static") && node.parent?.kind === SyntaxKind.InterfaceDeclaration && ts.hasStaticModifier(node);
}

/** @internal */
export function getRegisteredTSPPTypeExtensions(): readonly TSPPTypeExtension[] {
    return typeExtensionList;
}

/** @internal */
export function getRegisteredTSPPProgramRebuilders(): readonly TSPPProgramRebuilder[] {
    return [...programRebuilders.values()];
}

function initializeTSPPCompilerPlugins(compilerVersion: string): void {
    if (pluginHost) return;
    pluginHost = new TSPPPluginHost({
        compilerVersion,
        logger: silentLogger,
        // Plugins see the same public API that `typescript.js` exports.
        ts: ts as unknown as TSPPTypeScript,
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
    readonly provides?: readonly string[];
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

/**
 * Whether an expression rewriter renamed this parsed identifier, so that the emitter writes its new text instead of
 * the source text at its position. Only possible while a rewriter is active; escaped source spellings are kept.
 * @internal
 */
export function isTSPPRewrittenIdentifier(node: Node): boolean {
    if (!expressionRewriters.size || node.kind !== SyntaxKind.Identifier) return false;
    const text = ts.getSourceFileOfNode(node).text;
    const source = text.slice(ts.skipTrivia(text, node.pos), node.end);
    return !source.includes("\\") && source !== ts.idText(node as Identifier);
}

/**
 * Offers a just-parsed expression to the active expression rewriters; the first replacement wins.
 * @internal
 */
export function rewriteTSPPExpression(
    expression: Expression,
    factory: NodeFactory,
    parenthesized: boolean,
    pos: number,
    end: number,
): Expression | undefined {
    for (const rewriter of expressionRewriters.values()) {
        const rewritten = rewriter.rewrite(expression as any, { factory: factory as any, parenthesized, pos, end });
        if (rewritten) return rewritten as unknown as Expression;
    }
    return undefined;
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

/** Restores plugin-owned syntax before a function's `function` keyword for feature-rich declaration emit. @internal */
export function getPreprocessedFunctionPrefix(
    fileName: string,
    name: string,
    declarationStart: number,
): string | undefined {
    const entry = projectedSources.get(fileName);
    if (!entry) return undefined;
    for (const preprocessor of sourcePreprocessors.values()) {
        const restored = preprocessor.restoreFunctionPrefix?.({
            fileName,
            sourceText: entry.original,
            name,
            declarationStart,
        });
        if (restored) return restored;
    }
    return undefined;
}

/** Restores a plugin-owned function clause for feature-rich declaration emit. @internal */
export function getPreprocessedFunctionWithClause(
    fileName: string,
    name: string,
    declarationStart: number,
): string | undefined {
    const entry = projectedSources.get(fileName);
    if (!entry) return undefined;
    for (const preprocessor of sourcePreprocessors.values()) {
        const restored = preprocessor.restoreFunctionWithClause?.({
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
