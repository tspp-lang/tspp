import {
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import type {
    TSPPCompilerHostAPI,
    TSPPDiagnosticProvider,
    TSPPInterfaceMemberBinding,
    TSPPProgramAnalyzer,
    TSPPProgramRebuilder,
    TSPPSignatureConstraint,
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
    TSPPClearedSemanticToken,
    TSPPLanguageServiceHostAPI,
    TSPPQuickInfoProvider,
    TSPPSemanticToken,
    TSPPSemanticTokenImport,
    TSPPSemanticTokensProvider,
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
    NodeFlags,
    SyntaxKind,
} from "../types.js";
import { getTSPPCompatibilityDeclarationFilePath } from "./files.js";
import { getTSPPTypeOperations } from "./types.js";

const interfaceMemberBindings = new Map<string, TSPPInterfaceMemberBinding>();
const programAnalyzers = new Map<string, { pluginId: string; analyzer: TSPPProgramAnalyzer; }>();
const sourcePreprocessors = new Map<string, { pluginId: string; preprocessor: TSPPSourcePreprocessor; }>();
const programRebuilders = new Map<string, TSPPProgramRebuilder>();
const syntaxExtensions = new Map<TSPPSyntaxExtensionPosition, { pluginId: string; extension: TSPPSyntaxExtension; }[]>();
const diagnosticProviders = new Map<string, { pluginId: string; provider: TSPPDiagnosticProvider; }>();
const typeExtensions = new Map<string, TSPPTypeExtension>();
const signatureConstraints = new Map<string, TSPPSignatureConstraint>();
/** The active plugins, in activation order. */
const activePlugins: TSPPPlugin[] = [];
/** The plugin that parsed each syntax node or annotation. */
const syntaxOwners = new WeakMap<object, string>();
/** Who claims each `keyword @ position`, so that a second plugin is refused when it registers. */
const syntaxClaims = new Map<string, { pluginId: string; keyword: string; position: string; }>();
const additionalListElements = new WeakMap<Node, readonly Node[]>();
const quickInfoProviders = new Map<string, TSPPQuickInfoProvider>();
const semanticTokensProviders = new Map<string, TSPPSemanticTokensProvider>();
const projectedSources = new Map<string, ProjectedSource>();
let pluginHost: TSPPPluginHost | undefined;

/** A file's text as its preprocessors left it, with the text each one rewrote. */
interface ProjectedSource {
    readonly original: string;
    readonly projected: string;
    readonly spans: readonly { readonly start: number; readonly end: number; readonly pluginId: string; }[];
    readonly conflicts: readonly { readonly start: number; readonly length: number; readonly message: string; }[];
}

/**
 * Plugin syntax only exists in TS++ files; every other file is plain TypeScript, whatever plugins are active.
 *
 * These files are also never parsed incrementally. Their text is projected before parsing and plugins synthesize nodes,
 * while incremental parsing moves old nodes by a change range of the unprojected text. A tree patched that way has
 * ranges out of order, which crashes the services and can make token walks like signature help loop forever.
 *
 * @internal
 */
export function isTSPPFileName(fileName: string): boolean {
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
        return () => typeExtensions.delete(pluginId);
    },
    registerSignatureConstraint(pluginId, constraint) {
        if (signatureConstraints.has(pluginId)) throw new Error(`TSPP plugin '${pluginId}' registered more than one signature constraint.`);
        signatureConstraints.set(pluginId, constraint);
        return () => signatureConstraints.delete(pluginId);
    },
    registerProgramRebuilder(pluginId, rebuilder) {
        const key = `${pluginId}/${rebuilder.id}`;
        if (programRebuilders.has(key)) throw new Error(`Duplicate TSPP program rebuilder '${key}'.`);
        programRebuilders.set(key, rebuilder);
        return () => programRebuilders.delete(key);
    },
    getSyntaxKeywords(position) {
        return [...syntaxClaims.values()].filter(claim => claim.position === position).map(claim => claim.keyword).sort();
    },
    getAuthoredText(sourceFile) {
        const { fileName, text } = sourceFile as unknown as SourceFile;
        return getOriginalTSPPSource(fileName, text);
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
    registerSemanticTokensProvider(pluginId, provider) {
        if (semanticTokensProviders.has(pluginId)) {
            throw new Error(`TSPP plugin '${pluginId}' registered more than one semantic tokens provider.`);
        }
        semanticTokensProviders.set(pluginId, provider);
        return () => semanticTokensProviders.delete(pluginId);
    },
};

/** The parser marks what it finishes as ambient; nodes a plugin builds around them are ambient too. */
function markAmbient(node: Node): void {
    (node as { flags: NodeFlags; }).flags |= NodeFlags.Ambient;
    ts.forEachChild(node, markAmbient);
}

/** Moves a zero-width node with everything in it, which has no width either. */
function moveEmptySyntax(node: Node, pos: number): void {
    if (node.pos >= 0) ts.setTextRangePosEnd(node, pos, pos);
    ts.forEachChild(node, child => moveEmptySyntax(child, pos));
}

/**
 * Services walk a tree trusting that children lie inside their parent, but what plugins lower to rarely does: a name moves
 * into a generated declaration, and generated nodes sit wherever they were made. So a node stays in the source the plugin
 * parsed, grows to cover its children, and a zero-width child moves to its end, behind any real tokens. Sibling order can't be kept: lowering reorders.
 */
function nestSyntaxRanges(node: Node, start: number, limit: number): void {
    let pos = node.pos < 0 ? Infinity : Math.min(Math.max(node.pos, start), limit);
    let end = node.pos < 0 ? -Infinity : Math.min(Math.max(node.end, pos), limit);
    const cover = (range: ts.TextRange) => {
        if (range.pos < 0 || range.pos === range.end) return;
        pos = Math.min(pos, range.pos);
        end = Math.max(end, range.end);
    };
    ts.forEachChild(
        node,
        child => {
            nestSyntaxRanges(child, start, limit);
            cover(child);
        },
        children => {
            children.forEach(child => nestSyntaxRanges(child, start, limit));
            nestSyntaxListRange(children);
            cover(children);
        },
    );
    if (pos === Infinity) return;
    ts.setTextRangePosEnd(node, pos, end);
    ts.forEachChild(
        node,
        child => {
            if (child.pos >= 0 && child.pos === child.end && (child.pos < pos || child.end > end)) moveEmptySyntax(child, end);
        },
        children => {
            if (children.pos >= 0 && children.pos === children.end && (children.pos < pos || children.end > end)) ts.setTextRangePosEnd(children, end, end);
            children.forEach(child => {
                if (child.pos >= 0 && child.pos === child.end && (child.pos < pos || child.end > end)) moveEmptySyntax(child, end);
            });
        },
    );
}

/** A list covers its elements: services skip a list without a range, and everything in it, when they walk tokens. */
function nestSyntaxListRange(list: ts.NodeArray<Node>): void {
    const positioned = list.filter(element => element.pos >= 0 && element.pos !== element.end);
    if (!positioned.length) return;
    const pos = Math.min(...positioned.map(element => element.pos), list.pos < 0 ? Infinity : list.pos);
    const end = Math.max(...positioned.map(element => element.end), list.end);
    ts.setTextRangePosEnd(list, pos, end);
}

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
    const start = Math.min(cursor!.getNodePos(), cursor!.modifiers?.pos ?? Infinity, cursor!.precedingType?.pos ?? Infinity);
    const parsed = extension.parse(cursor!) as unknown as Node | readonly Node[];
    const [first, ...rest] = Array.isArray(parsed) ? parsed : [parsed];
    if (typeof first !== "function") [first, ...rest].forEach(node => nestSyntaxRanges(node, start, cursor!.getNodePos()));
    if (cursor!.inAmbientContext() && typeof first !== "function") [first, ...rest].forEach(markAmbient);
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

/** What a plugin hands the binder beside a node's children, for what it recorded outside the tree. @internal */
export function getTSPPBoundChild(node: Node): Node | undefined {
    for (const candidates of syntaxExtensions.values()) {
        for (const { extension } of candidates) {
            const child = extension.getBoundChild?.(node as never);
            if (child) return child as unknown as Node;
        }
    }
    return undefined;
}

const clauseOwners = new WeakMap<Node, string>();

/**
 * A clause another plugin's syntax holds: applying it to the declaration that plugin builds runs the clause's annotation
 * and leaves the declaration its owner's, while the clause's plugin still writes its compatible output. @internal
 */
export function createTSPPClause(annotation: unknown): TSPPSyntaxAnnotation | undefined {
    if (typeof annotation !== "function") return undefined;
    return declaration => {
        (annotation as TSPPSyntaxAnnotation)(declaration);
        const owner = syntaxOwners.get(annotation);
        if (owner) clauseOwners.set(declaration as never, owner);
    };
}

/** Whether a plugin parsed this node. @internal */
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
 * Prints a node inside the declaration `container` restores, restoring whatever plugin syntax it holds. Each call has
 * its own printer because a restorer it reaches may print nested nodes in turn.
 */
function printNestedDeclaration(container: Node, nested: Node): string {
    const printer = ts.createPrinter({ removeComments: true, tsppNestedDeclaration: true });
    return printer.printNode(ts.EmitHint.Unspecified, nested, ts.getSourceFileOfNode(ts.getOriginalNode(container)));
}

/**
 * The text a plugin restores for a node in feature-rich declaration output, or the text it gives the node in the
 * TypeScript-compatible declaration output. Only the plugin that parsed a node answers for it; for other nodes, such
 * as ordinary declarations a plugin omits, at most one plugin may answer.
 * @internal
 */
export function getTSPPRestoredDeclaration(node: Node, compatibility?: boolean): string | undefined {
    const clauseOwner = compatibility ? clauseOwners.get(ts.getOriginalNode(node)) : undefined;
    const owner = clauseOwner ?? syntaxOwners.get(ts.getOriginalNode(node));
    const printNested = (nested: Node) => printNestedDeclaration(node, nested);
    let restored: string | undefined;
    let answeredBy: string | undefined;
    for (const candidates of syntaxExtensions.values()) {
        for (const { pluginId, extension } of candidates) {
            if (owner && pluginId !== owner) continue;
            const text = compatibility ? extension.restoreCompatibilityDeclaration?.(node as never) : extension.restoreDeclaration?.(node as never, printNested as never);
            if (text === undefined) continue;
            if (answeredBy && answeredBy !== pluginId && text !== restored) throw new Error(`TSPP plugins '${answeredBy}' and '${pluginId}' both restore the same declaration.`);
            restored = text;
            answeredBy = pluginId;
        }
    }
    return restored;
}

/** The text of a clause plugin syntax parsed after a function's parameters, for `.d.tspp` output. @internal */
export function getTSPPRestoredFunctionClause(node: Node): string | undefined {
    const owner = clauseOwners.get(ts.getOriginalNode(node)) ?? syntaxOwners.get(ts.getOriginalNode(node));
    if (!owner) return undefined;
    for (const { pluginId, extension } of [...syntaxExtensions.get("function-clause") ?? [], ...syntaxExtensions.get("header-clause") ?? []]) {
        if (pluginId !== owner) continue;
        const text = extension.restoreFunctionClause?.(node as never);
        if (text) return text;
    }
    return undefined;
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
export function isTSPPStaticSideMember(node: Node): boolean {
    if (!interfaceMemberBindings.size || node.parent?.kind !== SyntaxKind.InterfaceDeclaration) return false;
    if (!isTSPPFileName(ts.getSourceFileOfNode(node).fileName)) return false;
    return [...interfaceMemberBindings.values()].some(binding => binding.isStaticMember(node as never));
}

/** Whether a type node is in a TS++ file; nodes outside the parse tree count, since only plugins create them. @internal */
export function isTSPPSyntaxAllowedAt(node: Node): boolean {
    const sourceFile = ts.getSourceFileOfNode(node) as SourceFile | undefined;
    return !sourceFile || isTSPPFileName(sourceFile.fileName);
}

/** The syntax active plugins claim, as they registered it. @internal */
export function getRegisteredTSPPSyntaxClaims(): readonly { readonly pluginId: string; readonly keyword: string; readonly position: string; }[] {
    return [...syntaxClaims.values()];
}

/** @internal */
export function getRegisteredTSPPTypeExtensions(): readonly TSPPTypeExtension[] {
    return sortedByKey(typeExtensions);
}

/** @internal */
export function getRegisteredTSPPSignatureConstraints(): readonly TSPPSignatureConstraint[] {
    return sortedByKey(signatureConstraints);
}

/** The members signature constraints add to `type`, for completions. @internal */
export function getTSPPMembers(program: Program, checker: ts.TypeChecker, type: ts.Type): readonly ts.Symbol[] {
    const operations = getTSPPTypeOperations(program);
    if (!operations) return [];
    return getRegisteredTSPPSignatureConstraints().flatMap(constraint => constraint.getMembers?.({ type: type as never, checker: checker as never, types: operations }) ?? []) as unknown as readonly ts.Symbol[];
}

/** @internal */
export function getRegisteredTSPPProgramRebuilders(): readonly TSPPProgramRebuilder[] {
    return sortedByKey(programRebuilders);
}

/**
 * Creates the process-level host when the first plugin arrives, not when this module loads: `ts` and `version` come from
 * modules in a cycle with this one, which a bundler may initialize after it.
 */
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
    activePlugins.push(capsule);
    return true;
}

/** The first line of a `.d.tspp` file: the plugins of the project that wrote it, which a reader must have to read it. @internal */
export const tsppDeclarationPluginsHeader = "// @tspp-plugins ";

/**
 * The file to read in place of a `.d.tspp` file written with plugins that are not all active: its compatible `.d.ts`. By
 * design a project reads declarations of plugins it lacks as what they lower to, so a type TypeScript cannot express
 * arrives as that output's `unknown`. Undefined when the file itself is to be read, including one without a header.
 * @internal
 */
export function getTSPPReadableDeclaration(fileName: string, host: { fileExists(fileName: string): boolean; readFile(fileName: string): string | undefined; }): string | undefined {
    if (!fileName.endsWith(".d.tspp")) return undefined;
    const text = host.readFile(fileName);
    if (!text?.startsWith(tsppDeclarationPluginsHeader)) return undefined;
    const required = text.slice(tsppDeclarationPluginsHeader.length, text.search(/\r?\n/)).split(",");
    if (required.every(id => activePlugins.some(plugin => plugin.manifest.id === id))) return undefined;
    const compatible = getTSPPCompatibilityDeclarationFilePath(fileName)!;
    return host.fileExists(compatible) ? compatible : undefined;
}

/** The compiler facets active in this process, in activation order. @internal */
export function getActiveTSPPPlugins(): readonly TSPPPlugin[] {
    return [...activePlugins];
}

/**
 * Makes `plugins` exactly the active compiler facets, for a process that serves projects with different plugin sets one
 * after another. A plugin both sets share stays active with its state.
 * @internal
 */
export function setActiveTSPPPlugins(plugins: readonly TSPPPlugin[]): void {
    initializeTSPPCompilerPlugins(version);
    for (let index = activePlugins.length - 1; index >= 0; index--) {
        if (plugins.includes(activePlugins[index])) continue;
        pluginHost!.deactivate(activePlugins[index].manifest.id);
        activePlugins.splice(index, 1);
    }
    for (const plugin of plugins) {
        if (!activePlugins.includes(plugin)) registerTSPPCompilerPlugin(plugin);
    }
}

/**
 * The module paths of the active plugins, found among the loaded modules because tsserver hands the host a plugin's
 * exports, not its path. Undefined when one was not loaded as a module, as in a browser or from a bundle. @internal
 */
export function getTSPPPluginModulePaths(): readonly string[] | undefined {
    if (typeof require !== "function" || !require.cache) return undefined;
    const loaded = Object.values(require.cache) as ({ readonly filename: string; readonly exports?: { readonly default?: unknown; }; } | undefined)[];
    const paths: string[] = [];
    for (const plugin of activePlugins) {
        const found = loaded.find(module => module && (module.exports === plugin as unknown || module.exports?.default === plugin));
        if (!found) return undefined;
        paths.push(found.filename);
    }
    return paths;
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

/** Whether any plugin decides semantic tokens, so that gathering what providers read can be skipped. @internal */
export function hasTSPPSemanticTokensProviders(): boolean {
    return semanticTokensProviders.size !== 0;
}

/** What plugins replace among the semantic tokens of a TS++ file, in plugin id order. @internal */
export function getTSPPSemanticTokens(sourceFile: SourceFile, tokens: readonly TSPPSemanticToken[], imports: readonly TSPPSemanticTokenImport[]): readonly (TSPPSemanticToken | TSPPClearedSemanticToken)[] {
    const sourceText = getOriginalTSPPSource(sourceFile.fileName, sourceFile.text);
    return [...semanticTokensProviders.keys()].sort().flatMap(pluginId =>
        semanticTokensProviders.get(pluginId)!({
            fileName: sourceFile.fileName,
            sourceText,
            tokens,
            imports,
            isOwned: (start, end) => getTSPPSyntaxOwners(sourceFile, start, end, /*includeEmptyNodes*/ false).includes(pluginId),
        })
    );
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

/** Restores plugin-owned syntax before a function's `function` keyword for feature-rich declaration emit. @internal */
export function getPreprocessedFunctionPrefix(
    fileName: string,
    name: string,
    declarationStart: number,
): string | undefined {
    const entry = projectedSources.get(fileName);
    if (!entry) return undefined;
    for (const { preprocessor } of sortedByKey(sourcePreprocessors)) {
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
    for (const { preprocessor } of sortedByKey(sourcePreprocessors)) {
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
