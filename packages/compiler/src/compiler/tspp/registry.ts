import {
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import type {
    TSPPCompilerHostAPI,
    TSPPDiagnosticProvider,
    TSPPInterfaceMemberBinding,
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
    DiagnosticMessage,
    Node,
    Program,
    SourceFile,
} from "../types.js";
import {
    DiagnosticCategory,
    Extension,
    SyntaxKind,
} from "../types.js";
import { getTSPPTypeOperations } from "./types.js";

const interfaceMemberBindings = new Map<string, TSPPInterfaceMemberBinding>();
const programAnalyzers = new Map<string, { pluginId: string; analyzer: TSPPProgramAnalyzer; }>();
const sourcePreprocessors = new Map<string, { pluginId: string; preprocessor: TSPPSourcePreprocessor; }>();
const programRebuilders = new Map<string, TSPPProgramRebuilder>();
const syntaxExtensions = new Map<TSPPSyntaxExtensionPosition, { pluginId: string; extension: TSPPSyntaxExtension; }[]>();
const diagnosticProviders = new Map<string, { pluginId: string; provider: TSPPDiagnosticProvider; }>();
const typeExtensions = new Map<string, TSPPTypeExtension>();
const typeExtensionList: TSPPTypeExtension[] = [];
/** The plugin that parsed each syntax node or annotation. */
const syntaxOwners = new WeakMap<object, string>();
/** Who claims each `keyword @ position`, so that a second plugin is refused when it registers. */
const syntaxClaims = new Map<string, { pluginId: string; keyword: string; position: string; }>();
const additionalListElements = new WeakMap<Node, readonly Node[]>();
const quickInfoProviders = new Map<string, TSPPQuickInfoProvider>();
const projectedSources = new Map<string, ProjectedSource>();
let pluginHost: TSPPPluginHost | undefined;

/** A file's text as its preprocessors left it, with the text each one rewrote. */
interface ProjectedSource {
    readonly original: string;
    readonly projected: string;
    readonly spans: readonly { readonly start: number; readonly end: number; readonly pluginId: string; }[];
    readonly conflicts: readonly { readonly start: number; readonly length: number; readonly message: string; }[];
}

/** Plugin syntax only exists in TS++ files; every other file is plain TypeScript, whatever plugins are active. */
function isTSPPFileName(fileName: string): boolean {
    return fileName.endsWith(Extension.Tspp);
}

/** A registry's entries by plugin id and name: what plugins register must not take effect in load order. */
function sortedByKey<T>(registry: ReadonlyMap<string, T>): T[] {
    return [...registry.keys()].sort().map(key => registry.get(key)!);
}

function claimSyntax(pluginId: string, keywords: readonly string[], position: string): () => void {
    const keys = [...new Set(keywords)].map(keyword => ({ key: `${keyword} @ ${position}`, keyword }));
    for (const { key } of keys) {
        const existing = syntaxClaims.get(key);
        if (existing && existing.pluginId !== pluginId) throw new Error(`TSPP plugins '${existing.pluginId}' and '${pluginId}' both claim '${key}'.`);
    }
    const added = keys.filter(({ key }) => !syntaxClaims.has(key));
    for (const { key, keyword } of added) syntaxClaims.set(key, { pluginId, keyword, position });
    return () => added.forEach(({ key }) => syntaxClaims.delete(key));
}

const silentLogger: TSPPPluginLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

const compilerAPI: TSPPCompilerHostAPI = {
    registerInterfaceMemberBinding(pluginId, binding) {
        if (interfaceMemberBindings.has(pluginId)) {
            throw new Error(`TSPP plugin '${pluginId}' registered an interface member binding more than once.`);
        }
        const releaseClaims = claimSyntax(pluginId, binding.keywords, "interface-member");
        interfaceMemberBindings.set(pluginId, binding);
        return () => {
            releaseClaims();
            interfaceMemberBindings.delete(pluginId);
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
        const releaseClaims = preprocessor.claims.map(claim => claimSyntax(pluginId, [claim.keyword], claim.position));
        sourcePreprocessors.set(key, { pluginId, preprocessor });
        return () => {
            releaseClaims.forEach(release => release());
            sourcePreprocessors.delete(key);
        };
    },
    registerSyntaxExtension(pluginId, extension) {
        if (!extension.keywords?.length && (extension.startTokens as readonly number[]).includes(SyntaxKind.Identifier)) {
            throw new Error(`A syntax extension of TSPP plugin '${pluginId}' starts at identifiers, so it must name its keywords.`);
        }
        const releaseClaims = claimSyntax(pluginId, extension.keywords ?? [], extension.position);
        const entry = { pluginId, extension };
        const list = syntaxExtensions.get(extension.position) ?? [];
        list.push(entry);
        syntaxExtensions.set(extension.position, list);
        return () => {
            releaseClaims();
            const index = list.indexOf(entry);
            if (index >= 0) list.splice(index, 1);
        };
    },
    registerDiagnosticProvider(pluginId, provider) {
        const key = `${pluginId}/${provider.id}`;
        if (diagnosticProviders.has(key)) throw new Error(`Duplicate TSPP diagnostic provider '${key}'.`);
        diagnosticProviders.set(key, { pluginId, provider });
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

/** Lets plugin syntax registered for `position` parse at the current token of a TS++ file, if one starts there. @internal */
export function tryParseTSPPSyntax(fileName: string, position: TSPPSyntaxExtensionPosition, token: SyntaxKind, createCursor: () => TSPPSyntaxCursor): Node | undefined {
    const candidates = syntaxExtensions.get(position);
    if (!candidates?.length || !isTSPPFileName(fileName)) return undefined;
    let cursor: TSPPSyntaxCursor | undefined;
    const starting = candidates.filter(({ extension }) => {
        if (!(extension.startTokens as readonly number[]).includes(token)) return false;
        cursor ??= createCursor();
        return extension.isStart(cursor);
    });
    if (!starting.length) return undefined;
    // Which plugin parses must not depend on the order plugins were loaded in.
    if (starting.length > 1) throw new Error(`TSPP plugins ${starting.map(({ pluginId }) => `'${pluginId}'`).join(" and ")} both claim this syntax.`);
    const [{ pluginId, extension }] = starting;
    const parsed = extension.parse(cursor!) as unknown as Node | readonly Node[];
    const [first, ...rest] = Array.isArray(parsed) ? parsed : [parsed];
    syntaxOwners.set(first, pluginId);
    if (rest.length) additionalListElements.set(first, rest);
    return first;
}

/** Whether plugin syntax registered for `position` starts at the current token of a TS++ file; callers look ahead. @internal */
export function isStartOfTSPPSyntax(fileName: string, position: TSPPSyntaxExtensionPosition, token: SyntaxKind, createCursor: () => TSPPSyntaxCursor): boolean {
    const candidates = syntaxExtensions.get(position);
    if (!candidates?.length || !isTSPPFileName(fileName)) return false;
    const cursor = createCursor();
    return candidates.some(({ extension }) => (extension.startTokens as readonly number[]).includes(token) && extension.isStart(cursor));
}

/** A list element followed by the other statements its plugin syntax stands for. @internal */
export function expandTSPPListElement<T extends Node>(node: T): readonly T[] {
    const rest = additionalListElements.get(node);
    if (!rest) return [node];
    const owner = syntaxOwners.get(node)!;
    for (const element of rest) syntaxOwners.set(element, owner);
    return [node, ...rest as readonly T[]];
}

/** Hands a finished declaration to the plugin annotation parsed inside it; the declaration is never reused. @internal */
export function annotateTSPPSyntax<T extends Node>(declaration: T, annotation: unknown): T {
    if (typeof annotation === "function") {
        (annotation as TSPPSyntaxAnnotation)(declaration as never);
        syntaxOwners.set(declaration, syntaxOwners.get(annotation)!);
    }
    return declaration;
}

/** Plugin syntax is parsed again rather than reused by incremental parsing, so it never reuses a partial result. @internal */
export function isTSPPSyntaxNode(node: Node): boolean {
    return syntaxOwners.has(node);
}

/**
 * The plugins whose syntax contains a range of a TS++ file, innermost first: syntax they parsed, and text they rewrote
 * before parsing. Nothing else can say which plugin a piece of source belongs to, and it does not depend on the order
 * plugins were loaded in.
 */
function getTSPPSyntaxOwners(sourceFile: SourceFile, start: number, end: number, includeEmptyNodes: boolean): readonly string[] {
    const owners: string[] = [];
    const add = (owner: string | undefined) => {
        if (owner && !owners.includes(owner)) owners.push(owner);
    };
    for (const span of projectedSources.get(sourceFile.fileName)?.spans ?? []) {
        if (span.start <= start && end <= span.end) add(span.pluginId);
    }
    const covers = (node: Node) => node.pos >= 0 && node.pos <= start && end <= node.end && (includeEmptyNodes || node.pos < node.end);
    /**
     * Whether `node` contains the range. Plugins generate nodes without a position, or empty ones at token starts that
     * may lie outside their parents, so the inside of plugin syntax is searched whatever its ranges say.
     */
    const visit = (node: Node, inSyntax: boolean): boolean => {
        const insideSyntax = inSyntax || syntaxOwners.has(node);
        let contains = covers(node);
        ts.forEachChild(node, child => {
            if (insideSyntax || child.pos < 0 || syntaxOwners.has(child) || covers(child)) contains = visit(child, insideSyntax) || contains;
        });
        if (contains) add(syntaxOwners.get(node));
        return contains;
    };
    visit(sourceFile, /*inSyntax*/ false);
    return owners;
}

/**
 * The text a plugin restores for a node in feature-rich declaration output, or the text it gives the node in the
 * TypeScript-compatible declaration output. Only the plugin that parsed a node answers for it; for other nodes, such
 * as ordinary declarations a plugin omits, at most one plugin may answer.
 * @internal
 */
export function getTSPPRestoredDeclaration(node: Node, compatibility?: boolean): string | undefined {
    const owner = syntaxOwners.get(ts.getOriginalNode(node));
    let restored: string | undefined;
    let answeredBy: string | undefined;
    for (const candidates of syntaxExtensions.values()) {
        for (const { pluginId, extension } of candidates) {
            if (owner && pluginId !== owner) continue;
            const text = compatibility ? extension.restoreCompatibilityDeclaration?.(node as never) : extension.restoreDeclaration?.(node as never);
            if (text === undefined) continue;
            if (answeredBy && answeredBy !== pluginId && text !== restored) throw new Error(`TSPP plugins '${answeredBy}' and '${pluginId}' both restore the same declaration.`);
            restored = text;
            answeredBy = pluginId;
        }
    }
    return restored;
}

/** A diagnostic as the plugins whose syntax contains it leave it: undefined when one drops it, or the last replacement. */
function filterTSPPDiagnostic<T extends Diagnostic>(diagnostic: T): T | undefined {
    if (!diagnosticProviders.size || !diagnostic.file || diagnostic.start === undefined || !isTSPPFileName(diagnostic.file.fileName)) return diagnostic;
    let result = diagnostic;
    for (const owner of getTSPPSyntaxOwners(diagnostic.file, diagnostic.start, diagnostic.start + (diagnostic.length ?? 0), /*includeEmptyNodes*/ true)) {
        for (const { pluginId, provider } of diagnosticProviders.values()) {
            if (pluginId !== owner) continue;
            const filtered = provider.filterDiagnostic?.(result as never) ?? true;
            if (filtered === false) return undefined;
            if (filtered !== true) result = filtered as unknown as T;
        }
    }
    return result;
}

/** Diagnostics as plugins filter them, such as suggestions about code a plugin generated. @internal */
export function filterTSPPDiagnostics<T extends Diagnostic>(diagnostics: readonly T[]): readonly T[] {
    if (!diagnosticProviders.size) return diagnostics;
    return ts.mapDefined(diagnostics, filterTSPPDiagnostic);
}

/** A source file's check diagnostics as plugins filter them, followed by the diagnostics plugins add. @internal */
export function applyTSPPSemanticDiagnostics(sourceFile: SourceFile, program: Program, diagnostics: Diagnostic[]): Diagnostic[] {
    if (!isTSPPFileName(sourceFile.fileName)) return diagnostics;
    const conflicts = projectedSources.get(sourceFile.fileName)?.conflicts ?? [];
    if (!diagnosticProviders.size && !conflicts.length) return diagnostics;
    const result = ts.mapDefined(diagnostics, filterTSPPDiagnostic);
    for (const conflict of conflicts) {
        result.push(ts.createFileDiagnostic(sourceFile, conflict.start, conflict.length, createTSPPDiagnosticMessage(), conflict.message));
    }
    if (!diagnosticProviders.size) return result;
    const checker = program.getTypeChecker();
    const types = ts.Debug.checkDefined(getTSPPTypeOperations(program));
    for (const { provider } of sortedByKey(diagnosticProviders)) {
        result.push(...provider.getSemanticDiagnostics(sourceFile as never, checker as never, types) as unknown as readonly Diagnostic[]);
    }
    return result;
}

/** A message with a plugin's own code; by default its text is the single argument. @internal */
export function createTSPPDiagnosticMessage(code = 18086, message = "{0}"): DiagnosticMessage {
    return { code, category: DiagnosticCategory.Error, key: `TSPP_plugin_message_${code}`, message };
}

/** Whether an interface member of a TS++ file is bound on the interface's static side. @internal */
export function isTSPPStaticInterfaceMember(node: Node): boolean {
    if (!interfaceMemberBindings.size || node.parent?.kind !== SyntaxKind.InterfaceDeclaration) return false;
    if (!isTSPPFileName(ts.getSourceFileOfNode(node).fileName)) return false;
    return [...interfaceMemberBindings.values()].some(binding => binding.isStaticMember(node as never));
}

/** Whether a type node is in a TS++ file; nodes outside the parse tree count, since only plugins create them. @internal */
export function isTSPPSyntaxAllowedAt(node: Node): boolean {
    const sourceFile = ts.getSourceFileOfNode(node) as SourceFile | undefined;
    return !sourceFile || isTSPPFileName(sourceFile.fileName);
}

/** The syntax active plugins claim, as they registered it. @internal @knipignore */
export function getRegisteredTSPPSyntaxClaims(): readonly { readonly pluginId: string; readonly keyword: string; readonly position: string; }[] {
    return [...syntaxClaims.values()];
}

/** @internal */
export function getRegisteredTSPPTypeExtensions(): readonly TSPPTypeExtension[] {
    return typeExtensionList;
}

/** @internal */
export function getRegisteredTSPPProgramRebuilders(): readonly TSPPProgramRebuilder[] {
    return sortedByKey(programRebuilders);
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
export function hasTSPPQuickInfoProviders(): boolean {
    return quickInfoProviders.size !== 0;
}

/**
 * The first answer of the Quick Info providers: those of the plugins whose syntax contains the position, innermost
 * first, then the others by plugin id.
 * @internal
 */
export function getTSPPQuickInfo(
    sourceFile: SourceFile,
    sourceText: string,
    position: number,
    context?: {
        readonly token?: { readonly start: number; readonly length: number; readonly text: string; };
        readonly semanticType?: string;
        readonly upstream?: { readonly display: string; readonly kind: string; };
    },
): { readonly start: number; readonly length: number; readonly display: string; readonly documentation?: string; } | undefined {
    if (!isTSPPFileName(sourceFile.fileName)) return undefined;
    const owners = getTSPPSyntaxOwners(sourceFile, position, position, /*includeEmptyNodes*/ false);
    const others = [...quickInfoProviders.keys()].filter(pluginId => !owners.includes(pluginId)).sort();
    for (const pluginId of [...owners, ...others]) {
        const result = quickInfoProviders.get(pluginId)?.({ fileName: sourceFile.fileName, sourceText, position, owned: owners.includes(pluginId), ...context });
        if (result) return result;
    }
    return undefined;
}

/** @internal */
export function getRegisteredTSPPProgramAnalyzers(): readonly any[] {
    return sortedByKey(programAnalyzers).map(registration => registration.analyzer);
}

/** Runs of `next` that differ from `original`, joined across whitespace, so that one rewrite is one span. */
function changedSpans(original: string, next: string): { start: number; end: number; }[] {
    const spans: { start: number; end: number; }[] = [];
    let unchangedText = "";
    for (let index = 0; index < original.length; index++) {
        if (next[index] === original[index]) {
            unchangedText += original[index];
            continue;
        }
        const last = spans[spans.length - 1];
        if (last && !unchangedText.trim()) last.end = index + 1;
        else spans.push({ start: index, end: index + 1 });
        unchangedText = "";
    }
    return spans;
}

function checkProjection(id: string, original: string, next: string): void {
    if (next.length !== original.length) {
        throw new Error(`TSPP source preprocessor '${id}' changed the source length.`);
    }
    for (let index = 0; index < next.length; index++) {
        if ((next.charCodeAt(index) === 10 || next.charCodeAt(index) === 13) !== (original.charCodeAt(index) === 10 || original.charCodeAt(index) === 13)) {
            throw new Error(`TSPP source preprocessor '${id}' changed line breaks.`);
        }
    }
}

/**
 * Applies length-preserving feature projections before the upstream parser sees a TS++ file. Every preprocessor sees
 * the authored text, so none depends on what another did or on the order plugins were loaded in. The first to rewrite
 * a span by plugin id keeps it, and a different rewrite of the same text is reported on the file.
 * @internal
 */
export function projectTSPPSource(fileName: string, sourceText: string): string {
    if (!sourcePreprocessors.size || !isTSPPFileName(fileName)) return sourceText;
    const existing = projectedSources.get(fileName);
    if (existing?.projected === sourceText) return sourceText;
    const characters = sourceText.split("");
    const spans: { start: number; end: number; pluginId: string; }[] = [];
    const conflicts: { start: number; length: number; message: string; }[] = [];
    for (const { pluginId, preprocessor } of sortedByKey(sourcePreprocessors)) {
        const next = preprocessor.preprocess(fileName, sourceText);
        if (next === sourceText) continue;
        checkProjection(preprocessor.id, sourceText, next);
        for (const span of changedSpans(sourceText, next)) {
            const overlap = spans.find(other => other.pluginId !== pluginId && other.start < span.end && span.start < other.end);
            if (overlap && characters.slice(span.start, span.end).join("") !== next.slice(span.start, span.end)) {
                conflicts.push({
                    start: span.start,
                    length: span.end - span.start,
                    message: `TSPP plugins '${overlap.pluginId}' and '${pluginId}' both claim this text.`,
                });
                continue;
            }
            for (let index = span.start; index < span.end; index++) characters[index] = next[index];
            spans.push({ ...span, pluginId });
        }
    }
    const projected = characters.join("");
    if (projected !== sourceText || conflicts.length) projectedSources.set(fileName, { original: sourceText, projected, spans, conflicts });
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
    for (const { preprocessor } of sourcePreprocessors.values()) {
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
    for (const { preprocessor } of sourcePreprocessors.values()) {
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
export function getPreprocessedFunctionClause(
    fileName: string,
    name: string,
    declarationStart: number,
): string | undefined {
    const entry = projectedSources.get(fileName);
    if (!entry) return undefined;
    for (const { preprocessor } of sourcePreprocessors.values()) {
        const restored = preprocessor.restoreFunctionClause?.({
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
