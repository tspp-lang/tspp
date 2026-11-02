import type {
    TSPPProgramRebuild,
    TSPPProgramRebuildRequest,
    TSPPStatementReplacement,
} from "@tspp/plugin-sdk/compiler";

import type {
    CreateSourceFileOptions,
    Mutable,
} from "../_namespaces/ts.js";
import {
    createCompilerHost,
    createProgram,
    createSourceFile,
    forEachChild,
    getScriptKindFromFileName,
    getSourceFileOfNode,
    isStatement,
    normalizePath,
    setParentRecursive,
    setTextRange,
    skipTrivia,
    visitEachChild,
} from "../_namespaces/ts.js";
import type {
    CompilerHost,
    CreateProgramOptions,
    CustomTransformers,
    Diagnostic,
    Node,
    Program,
    ScriptTarget,
    SourceFile,
    Statement,
    Visitor,
} from "../types.js";
import { NodeFlags } from "../types.js";
import {
    getOriginalTSPPSource,
    getRegisteredTSPPProgramRebuilders,
    getTSPPPluginModulePaths,
} from "./registry.js";

type PublicProgram = Parameters<TSPPProgramRebuild["onRebuilt"] & {}>[0];

/** Nested programs built while a rebuilder runs, or while the rebuilt program is built, are not rebuilt again. */
let rebuildDepth = 0;

/**
 * Gives registered rebuilders the program `createProgram` just built and returns the rebuilt program, if any asked
 * for one. @internal
 */
export function rebuildTSPPProgram(program: Program, createProgramOptions: CreateProgramOptions, host: CompilerHost): Program {
    if (rebuildDepth || !getRegisteredTSPPProgramRebuilders().length) return program;
    rebuildDepth++;
    try {
        const rebuilds: TSPPProgramRebuild[] = [];
        for (const rebuilder of getRegisteredTSPPProgramRebuilders()) {
            const result = rebuilder.rebuild(program as unknown as PublicProgram, createRequest(host, /*async*/ false));
            if (isPromiseLike(result)) {
                throw new Error(`TSPP program rebuilder '${rebuilder.id}' returned a promise to a synchronous createProgram; use createProgramAsync.`);
            }
            if (result) rebuilds.push(result);
        }
        return rebuilds.length ? createRebuiltProgram(program, createProgramOptions, host, rebuilds) : program;
    }
    finally {
        rebuildDepth--;
    }
}

/** Creates a program and waits for program rebuilders that finish asynchronously, such as compile-time macros. */
export async function createProgramAsync(createProgramOptions: CreateProgramOptions): Promise<Program> {
    const host = createProgramOptions.host ?? createCompilerHost(createProgramOptions.options, /*setParentNodes*/ true);
    let program: Program;
    rebuildDepth++;
    try {
        program = createProgram({ ...createProgramOptions, host, oldProgram: undefined });
    }
    finally {
        rebuildDepth--;
    }
    const rebuilds: TSPPProgramRebuild[] = [];
    for (const rebuilder of getRegisteredTSPPProgramRebuilders()) {
        let result: ReturnType<typeof rebuilder.rebuild>;
        rebuildDepth++;
        try {
            result = rebuilder.rebuild(program as unknown as PublicProgram, createRequest(host, /*async*/ true));
        }
        finally {
            rebuildDepth--;
        }
        const rebuild = await result;
        if (rebuild) rebuilds.push(rebuild);
    }
    if (!rebuilds.length) return program;
    rebuildDepth++;
    try {
        return createRebuiltProgram(program, createProgramOptions, host, rebuilds);
    }
    finally {
        rebuildDepth--;
    }
}

function createRequest(host: CompilerHost, async: boolean): TSPPProgramRebuildRequest {
    return {
        host: host as unknown as TSPPProgramRebuildRequest["host"],
        async,
        invalidate: host.invalidateTSPPProgram && (() => host.invalidateTSPPProgram!()),
        compilerModulePath: getCompilerModulePath(),
        pluginModulePaths: getTSPPPluginModulePaths(),
    };
}

let compilerModulePath: string | undefined | false;

/** The public-API bundle beside this one; the command-line bundle exports nothing itself. */
function getCompilerModulePath(): string | undefined {
    if (compilerModulePath === undefined) {
        compilerModulePath = false;
        try {
            if (typeof __filename === "string" && typeof require === "function") {
                const path = require("path") as typeof import("path");
                const fs = require("fs") as typeof import("fs");
                const sibling = path.join(path.dirname(__filename), "typescript.js");
                compilerModulePath = fs.existsSync(sibling) ? sibling : __filename;
            }
        }
        catch {
            // Hosts without a module system, such as a browser worker, cannot load the compiler again.
        }
    }
    return compilerModulePath || undefined;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

function createRebuiltProgram(program: Program, createProgramOptions: CreateProgramOptions, host: CompilerHost, rebuilds: readonly TSPPProgramRebuild[]): Program {
    // Without replacements there is nothing to reparse: the program is kept and only gains the rebuilds' additions.
    if (rebuilds.every(rebuild => !rebuild.replacements.size)) return addRebuildResults(program, rebuilds);
    const replacements = new Map<string, TSPPStatementReplacement[]>();
    for (const rebuild of rebuilds) {
        for (const [fileName, fileReplacements] of rebuild.replacements) {
            const key = normalizePath(fileName);
            const existing = replacements.get(key);
            if (existing) existing.push(...fileReplacements);
            else replacements.set(key, [...fileReplacements]);
        }
    }

    const rebuiltHost = Object.create(host) as CompilerHost;
    const getReplacedSourceFile = (fileName: string, languageVersionOrOptions: ScriptTarget | CreateSourceFileOptions) => {
        const fileReplacements = replacements.get(normalizePath(fileName));
        const original = fileReplacements && program.getSourceFile(fileName);
        if (!original) return undefined;
        const replaced = createReplacedSourceFile(fileName, getOriginalTSPPSource(original.fileName, original.text), fileReplacements, languageVersionOrOptions);
        // A language service compares this with the host's script version to tell whether its program is up to date.
        (replaced as SourceFile & { version?: string; }).version = (original as SourceFile & { version?: string; }).version;
        return replaced;
    };
    rebuiltHost.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => getReplacedSourceFile(fileName, languageVersionOrOptions) ?? host.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    // Caching hosts, such as the command line's, read through this method first.
    if (host.getSourceFileByPath) {
        rebuiltHost.getSourceFileByPath = (fileName, path, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => getReplacedSourceFile(fileName, languageVersionOrOptions) ?? host.getSourceFileByPath!(fileName, path, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    }
    const rebuilt = createProgram({
        rootNames: createProgramOptions.rootNames,
        options: createProgramOptions.options,
        host: rebuiltHost,
        projectReferences: createProgramOptions.projectReferences,
        configFileParsingDiagnostics: createProgramOptions.configFileParsingDiagnostics,
        typeScriptVersion: createProgramOptions.typeScriptVersion,
    });
    return addRebuildResults(rebuilt, rebuilds);
}

/** Adds the rebuilds' diagnostics, diagnostic filters, and transformers to `rebuilt`, then hands it to each rebuild. */
function addRebuildResults(rebuilt: Program, rebuilds: readonly TSPPProgramRebuild[]): Program {
    const added = rebuilds.flatMap(rebuild => rebuild.diagnostics ?? []).map(diagnostic => {
        const file = diagnostic.file && rebuilt.getSourceFile(diagnostic.file.fileName);
        return { ...diagnostic, file } as Diagnostic;
    });
    const keep = (diagnostic: Diagnostic) => rebuilds.every(rebuild => rebuild.filterDiagnostic?.(diagnostic as never) ?? true);
    const getSemanticDiagnostics = rebuilt.getSemanticDiagnostics;
    rebuilt.getSemanticDiagnostics = (sourceFile, cancellationToken) => [
        ...getSemanticDiagnostics(sourceFile, cancellationToken).filter(keep),
        ...added.filter(diagnostic => !sourceFile || diagnostic.file?.fileName === sourceFile.fileName),
    ];
    const getSuggestionDiagnostics = rebuilt.getSuggestionDiagnostics;
    rebuilt.getSuggestionDiagnostics = (sourceFile, cancellationToken) => getSuggestionDiagnostics(sourceFile, cancellationToken).filter(keep);

    const transformers = rebuilds.map(rebuild => rebuild.transformers).filter(transformer => !!transformer) as CustomTransformers[];
    if (transformers.length) {
        const emit = rebuilt.emit;
        rebuilt.emit = ((targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, customTransformers, forceDtsEmit) => emit(targetSourceFile, writeFile, cancellationToken, emitOnlyDtsFiles, mergeTransformers([customTransformers, ...transformers]), forceDtsEmit)) as Program["emit"];
    }
    for (const rebuild of rebuilds) rebuild.onRebuilt?.(rebuilt as unknown as PublicProgram);
    return rebuilt;
}

function mergeTransformers(all: readonly (CustomTransformers | undefined)[]): CustomTransformers {
    return {
        before: all.flatMap(transformers => transformers?.before ?? []),
        after: all.flatMap(transformers => transformers?.after ?? []),
        afterDeclarations: all.flatMap(transformers => transformers?.afterDeclarations ?? []),
    };
}

/** Parses `fileName` and swaps each replaced statement for the statements its replacement returns. */
function createReplacedSourceFile(
    fileName: string,
    text: string,
    replacements: readonly TSPPStatementReplacement[],
    languageVersionOrOptions: ScriptTarget | CreateSourceFileOptions,
): SourceFile {
    const sourceFile = createSourceFile(fileName, text, languageVersionOrOptions, /*setParentNodes*/ true, getScriptKindFromFileName(fileName));
    const byRange = new Map(replacements.map(replacement => [`${replacement.start}:${replacement.end}`, replacement]));
    const inserted = new Set<Node>();
    const visitor: Visitor = node => {
        const replacement = isStatement(node) ? byRange.get(`${skipTrivia(sourceFile.text, node.pos)}:${node.end}`) : undefined;
        if (replacement) {
            const statements = replacement.replace(node as Statement as never, sourceFile as never) as unknown as readonly Statement[];
            for (const statement of statements) {
                if (statement === node) continue;
                // A replacement node without source coordinates becomes an empty range at the end of the replaced
                // statement, so syntax-list scanning skips it while editor positions address only the source text.
                if (statement.pos < 0) setTextRange(statement, { pos: node.end, end: node.end });
                inserted.add(statement);
            }
            return statements as Statement[];
        }
        return visitEachChild(node, visitor, /*context*/ undefined);
    };
    const rebuilt = setParentRecursive(visitEachChild(sourceFile, visitor, /*context*/ undefined), /*incremental*/ false);
    // visitEachChild re-creates every node on the path to a replacement (the source file itself included) through the
    // factory, which flags the copy Synthesized and points `original` at the parsed node. In the rebuilt program those
    // copies and the replacements are the parse tree: they are bound and checked. Left flagged, getParseTreeNode (used
    // by checker APIs and declaration emit) would redirect to nodes this program never bound, or find nothing.
    const markParseTree = (node: Node, replacementNode: boolean): void => {
        if (node.flags & NodeFlags.Synthesized && (replacementNode || node.original && getSourceFileOfNode(node.original) === sourceFile)) {
            (node as Mutable<Node>).flags &= ~NodeFlags.Synthesized;
        }
        forEachChild(node, child => markParseTree(child, replacementNode || inserted.has(child)));
    };
    markParseTree(rebuilt, /*replacementNode*/ false);
    return rebuilt;
}
