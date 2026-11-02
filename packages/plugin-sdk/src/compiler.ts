import type { TSPPPluginDependencies, TSPPPluginDisposer, TSPPPluginLogger } from "./index";

/** Immutable, compiler-neutral syntax snapshot supplied to background analyzers. */
export interface TSPPAnalysisNode {
    readonly kind: number;
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly children: readonly TSPPAnalysisNode[];
}

export interface TSPPAnalysisSyntaxKinds {
    readonly sourceFile: number;
    readonly labeledStatement: number;
}

export interface TSPPAnalysisSourceFile {
    readonly fileName: string;
    readonly text: string;
    readonly root: TSPPAnalysisNode;
}

export interface TSPPProgramAnalysisInput {
    readonly currentDirectory: string;
    readonly rootFileNames: readonly string[];
    readonly sourceFiles: readonly TSPPAnalysisSourceFile[];
    readonly syntaxKinds: TSPPAnalysisSyntaxKinds;
}

export interface TSPPAnalysisDiagnostic {
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly message: string;
    readonly code: number;
    readonly category: "warning" | "error";
    readonly source?: string;
}

/** Replayable or human-readable output produced by an isolated analyzer. */
export interface TSPPAnalysisArtifact {
    /** Stable plugin-owned category used by generic editor integrations. */
    readonly kind?: string;
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly name: string;
    readonly language: string;
    readonly content: string;
    readonly status?: "proved" | "failed" | "unknown" | "error";
}

export type TSPPProgramAnalysisOutput = readonly TSPPAnalysisDiagnostic[] & {
    readonly artifacts?: readonly TSPPAnalysisArtifact[];
};

export interface TSPPProgramAnalyzer {
    readonly id: string;
    analyze(input: TSPPProgramAnalysisInput): Promise<TSPPProgramAnalysisOutput>;
}

export interface TSPPSourcePreprocessor {
    readonly id: string;
    /** Must return text with exactly the same UTF-16 length and line breaks. */
    preprocess(fileName: string, sourceText: string): string;
    /**
     * Restores a type alias owned by this preprocessor for feature-rich
     * `.d.tspp` output. Compatibility `.d.ts` output continues to use the
     * projected syntax seen by TypeScript.
     */
    restoreTypeAliasDeclaration?(request: TSPPPreprocessedTypeAliasRequest): TSPPPreprocessedTypeAlias | undefined;
    /** Restores a preprocessed function `with` clause for `.d.tspp` output. */
    restoreFunctionWithClause?(request: TSPPPreprocessedFunctionRequest): string | undefined;
    /** Restores preprocessed syntax written before a function's `function` keyword for `.d.tspp` output. */
    restoreFunctionPrefix?(request: TSPPPreprocessedFunctionRequest): string | undefined;
}

export interface TSPPPreprocessedTypeAliasRequest {
    readonly fileName: string;
    readonly sourceText: string;
    readonly name: string;
    readonly declarationStart: number;
}

export interface TSPPPreprocessedTypeAlias {
    readonly annotation?: string;
    readonly type: string;
}

export interface TSPPPreprocessedFunctionRequest {
    readonly fileName: string;
    readonly sourceText: string;
    readonly name: string;
    readonly declarationStart: number;
}

/**
 * Inspects a program after it is built and asks the host to build it again with some statements replaced. The host
 * reparses each named file from the same text, swaps in the replacements, and builds the final program from those
 * files; nested `createProgram` calls made while rebuilding are not rebuilt again.
 */
export interface TSPPProgramRebuilder {
    readonly id: string;
    /** Returns undefined to keep `program`. A promise is only allowed when `request.async` is true. */
    rebuild(
        program: import("typescript-upstream").Program,
        request: TSPPProgramRebuildRequest,
    ): TSPPProgramRebuild | undefined | PromiseLike<TSPPProgramRebuild | undefined>;
}

export interface TSPPProgramRebuildRequest {
    readonly host: import("typescript-upstream").CompilerHost;
    /** True when the caller awaits the rebuild (`createProgramAsync`). */
    readonly async: boolean;
    /**
     * Present in long-lived hosts such as the language service: asks the host to build its program again later, for
     * work that settled after a synchronous rebuild returned.
     */
    readonly invalidate?: () => void;
    /** A module path that loads this compiler's public API, when it can be loaded again (for example in a worker). */
    readonly compilerModulePath?: string;
}

export interface TSPPProgramRebuild {
    /**
     * Replacements by file name. Each covers one statement of the original program, matched by its start and end.
     * When no rebuild has replacements, the host keeps the program and only adds the diagnostics, filters, and
     * transformers below to it.
     */
    readonly replacements: ReadonlyMap<string, readonly TSPPStatementReplacement[]>;
    /** Semantic diagnostics added to the rebuilt program; their files are matched by name. */
    readonly diagnostics?: readonly import("typescript-upstream").Diagnostic[];
    /** Return false to drop a semantic or suggestion diagnostic of the rebuilt program. */
    filterDiagnostic?(diagnostic: import("typescript-upstream").Diagnostic): boolean;
    /** Transformers added whenever the rebuilt program emits. */
    readonly transformers?: import("typescript-upstream").CustomTransformers;
    /** Receives the rebuilt program, so the plugin can associate its results with it. */
    onRebuilt?(program: import("typescript-upstream").Program): void;
}

/**
 * Replaces one statement, found by the start (after trivia) and end of its range, in the reparsed file. Nodes the
 * replacement creates keep their positions when set (`ts.setTextRange`); the host places the others, zero-width,
 * at the end of the replaced statement, and treats every replacement node as part of the parse tree.
 */
export interface TSPPStatementReplacement {
    readonly start: number;
    readonly end: number;
    replace(statement: import("typescript-upstream").Statement, sourceFile: import("typescript-upstream").SourceFile): readonly import("typescript-upstream").Statement[];
}

/**
 * Where plugin syntax may start: a unary expression, a statement, a function body after its signature, a declaration,
 * which may follow modifiers such as `export`, a type, the continuation of an already parsed type (`precedingType`),
 * or an annotation after a type parameter's name or after a type alias's name and type parameters.
 */
export type TSPPSyntaxExtensionPosition =
    | "expression"
    | "statement"
    | "function-body"
    | "declaration"
    | "type"
    | "postfix-type"
    | "type-parameter-annotation"
    | "type-alias-annotation";

/**
 * What an annotation position's `parse` returns: the parser calls it with the declaration the annotation belongs to,
 * once that declaration is finished.
 */
export type TSPPSyntaxAnnotation = (declaration: import("typescript-upstream").Node) => void;

/**
 * The parser at the start of plugin syntax. A plugin reads tokens, parses ordinary TypeScript parts, and builds its
 * result from them with the parser's own `factory`; `finishNode` gives a created node its source range.
 */
export interface TSPPSyntaxCursor {
    readonly factory: import("typescript-upstream").NodeFactory;
    /** The modifiers already parsed before a declaration, such as `export`. */
    readonly modifiers: import("typescript-upstream").NodeArray<import("typescript-upstream").ModifierLike> | undefined;
    token(): import("typescript-upstream").SyntaxKind;
    tokenText(): string;
    nextToken(): import("typescript-upstream").SyntaxKind;
    hasPrecedingLineBreak(): boolean;
    lookAhead<T>(callback: () => T): T;
    /** The position the next node would start at, including leading trivia. */
    getNodePos(): number;
    getTokenStart(): number;
    parseExpected(kind: import("typescript-upstream").SyntaxKind): boolean;
    parseOptional(kind: import("typescript-upstream").SyntaxKind): boolean;
    parseSemicolon(): boolean;
    parseExpression(): import("typescript-upstream").Expression;
    parseAssignmentExpression(): import("typescript-upstream").Expression;
    /** A block; in a function body it is parsed with the function's yield and await context. */
    parseBlock(): import("typescript-upstream").Block;
    parseStatement(): import("typescript-upstream").Statement;
    /** Whether the parser is in an ambient context, such as a declaration file or a `declare` block. */
    inAmbientContext(): boolean;
    /** Runs `callback` in the yield and await context of the function whose body is being parsed. */
    runInFunctionBody<T>(callback: () => T): T;
    parseBindingName(): import("typescript-upstream").BindingName;
    parseTypeAnnotation(): import("typescript-upstream").TypeNode | undefined;
    parseType(): import("typescript-upstream").TypeNode;
    parseIdentifier(): import("typescript-upstream").Identifier;
    parseTypeParameters(): import("typescript-upstream").NodeArray<import("typescript-upstream").TypeParameterDeclaration> | undefined;
    /** Type arguments `<...>` at the current token, if it is `<` on the same line. */
    parseTypeArguments(): import("typescript-upstream").NodeArray<import("typescript-upstream").TypeNode> | undefined;
    /** In the `postfix-type` position, the type parsed so far, which the result replaces. */
    readonly precedingType?: import("typescript-upstream").TypeNode;
    parseVariableDeclarationList(inForStatementInitializer: boolean): import("typescript-upstream").VariableDeclarationList;
    finishNode<T extends import("typescript-upstream").Node>(node: T, pos: number, end?: number): T;
    /** Reports a syntax error for `start` to `end`. */
    parseErrorAt(start: number, end: number, message: string): void;
}

/** Syntax a plugin parses into ordinary TypeScript nodes, which the compiler then binds, checks, and emits unchanged. */
export interface TSPPSyntaxExtension {
    readonly position: TSPPSyntaxExtensionPosition;
    readonly startTokens: readonly import("typescript-upstream").SyntaxKind[];
    isStart(cursor: TSPPSyntaxCursor): boolean;
    /**
     * Returns an expression, a statement, a function body block, or a type, matching `position`; an annotation
     * position returns a `TSPPSyntaxAnnotation`. A statement or declaration may stand for several statements; the
     * parser places the rest after the first in the enclosing list.
     */
    parse(cursor: TSPPSyntaxCursor):
        | import("typescript-upstream").Node
        | readonly import("typescript-upstream").Statement[]
        | TSPPSyntaxAnnotation;
    /**
     * The text of a node in feature-rich `.d.tspp` output, such as the authored declaration or type; an empty string
     * omits a statement. `node` is the declaration emitter's node, a statement or a type-level node.
     */
    restoreDeclaration?(node: import("typescript-upstream").Node): string | undefined;
    /** The text of a node in the TypeScript-compatible `.d.ts` output that accompanies `.d.tspp` output. */
    restoreCompatibilityDeclaration?(node: import("typescript-upstream").Node): string | undefined;
}

/** A type the checker hands to a type extension's instantiation, mapping type parameters to types. Opaque. */
export interface TSPPTypeMapper {
    readonly __tsppTypeMapper: never;
}

/** Type operations of one type checker, for a type extension. */
export interface TSPPTypeHost {
    readonly checker: import("typescript-upstream").TypeChecker;
    /** The type the checker uses after reporting an error, which suppresses further errors. */
    readonly errorType: import("typescript-upstream").Type;
    /**
     * A new type owned by the calling extension. The checker treats it like a type parameter named by `symbol` and
     * leaves its instantiation and printing to the extension.
     */
    createType(symbol?: import("typescript-upstream").Symbol): import("typescript-upstream").Type;
    /** The type, alias resolved, that a type reference names, without reporting errors; undefined if none. */
    resolveTypeReferenceName(node: import("typescript-upstream").TypeReferenceNode): import("typescript-upstream").Symbol | undefined;
    /** The type parameters a generic type alias, class, or interface declares; undefined for other symbols. */
    getTypeParametersOfSymbol(symbol: import("typescript-upstream").Symbol): readonly import("typescript-upstream").TypeParameter[] | undefined;
    /** A generic type alias, class, or interface applied to type arguments. */
    instantiateGenericType(
        symbol: import("typescript-upstream").Symbol,
        typeArguments: readonly import("typescript-upstream").Type[],
    ): import("typescript-upstream").Type;
    createMapper(
        sources: readonly import("typescript-upstream").TypeParameter[],
        targets: readonly import("typescript-upstream").Type[],
    ): TSPPTypeMapper;
    /** A mapper that applies `first`, when present, and then `second`. */
    combineMappers(first: TSPPTypeMapper | undefined, second: TSPPTypeMapper): TSPPTypeMapper;
    instantiate(type: import("typescript-upstream").Type, mapper: TSPPTypeMapper): import("typescript-upstream").Type;
    /** Reports at `node` that a type argument does not satisfy its constraint, unless it does. */
    checkTypeArgumentConstraint(
        typeArgument: import("typescript-upstream").Type,
        constraint: import("typescript-upstream").Type,
        node: import("typescript-upstream").Node,
    ): boolean;
    /** Reports a semantic error at `node`. */
    error(node: import("typescript-upstream").Node, message: string): void;
}

/**
 * Lets a plugin give type nodes types that ordinary TypeScript cannot express. The checker asks the extension first
 * whenever it resolves a type node, and leaves the types the extension created to it.
 */
export interface TSPPTypeExtension {
    /** The type of `node`, or undefined to resolve it the ordinary way. Results are not cached by the checker. */
    resolveTypeNode(node: import("typescript-upstream").TypeNode, host: TSPPTypeHost): import("typescript-upstream").Type | undefined;
    /** Instantiates a type this extension created. */
    instantiateType(type: import("typescript-upstream").Type, mapper: TSPPTypeMapper, host: TSPPTypeHost): import("typescript-upstream").Type;
    /**
     * Whether `typeParameter` may be named by a type reference that has type arguments, which ordinary TypeScript
     * rules out when it decides what a type needs to be instantiated with.
     */
    isTypeParameterApplicable?(typeParameter: import("typescript-upstream").TypeParameter): boolean;
    /** How a type this extension created is written in hovers and messages; undefined for the ordinary text. */
    typeToTypeNode?(type: import("typescript-upstream").Type, host: TSPPTypeHost): import("typescript-upstream").TypeNode | undefined;
}

/** Semantic diagnostics a plugin adds to each source file; comment directives such as `@ts-expect-error` apply. */
export interface TSPPDiagnosticProvider {
    readonly id: string;
    getSemanticDiagnostics(
        sourceFile: import("typescript-upstream").SourceFile,
        checker: import("typescript-upstream").TypeChecker,
    ): readonly import("typescript-upstream").Diagnostic[];
    /**
     * Return false to drop a diagnostic the checker reported, for example one about code this plugin generated, or a
     * diagnostic to report in its place, for example at the source text a generated node stands for.
     */
    filterDiagnostic?(diagnostic: import("typescript-upstream").Diagnostic): boolean | import("typescript-upstream").Diagnostic;
}

/** Where an expression being rewritten was parsed, and the factory for nodes that should count as parsed source. */
export interface TSPPExpressionRewriteContext {
    /** True for the inner expression of `( ... )`; the replacement must then be a parenthesized expression. */
    readonly parenthesized: boolean;
    /** The source range the replacement covers, including the parentheses when `parenthesized` is true. */
    readonly pos: number;
    readonly end: number;
    /** The parser's own factory. Nodes it creates and `ts.setTextRange` places behave like parsed source. */
    readonly factory: import("typescript-upstream").NodeFactory;
}

/**
 * Rewrites a just-parsed parenthesized expression or call argument into other ordinary TypeScript syntax. An identifier
 * whose text the rewrite changes is emitted with its new text.
 */
export interface TSPPExpressionRewriter {
    rewrite(
        expression: import("typescript-upstream").Expression,
        context: TSPPExpressionRewriteContext,
    ): import("typescript-upstream").Expression | undefined;
}

/**
 * Moves interface members carrying a modifier onto a separate implementation
 * contract. The first supported contract mirrors the constructor side of a
 * class without exposing compiler AST types to plugins.
 */
export interface TSPPInterfaceMemberContract {
    readonly modifier: "static";
    readonly implementationSide: "class-static";
    readonly thisType: "implementing-instance";
}

export interface TSPPCompilerPluginAPI {
    registerInterfaceMemberContract(contract: TSPPInterfaceMemberContract): TSPPPluginDisposer;
    registerProgramAnalyzer(analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerExpressionRewriter(rewriter: TSPPExpressionRewriter): TSPPPluginDisposer;
    registerProgramRebuilder(rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
    registerSyntaxExtension(extension: TSPPSyntaxExtension): TSPPPluginDisposer;
    registerDiagnosticProvider(provider: TSPPDiagnosticProvider): TSPPPluginDisposer;
    registerTypeExtension(extension: TSPPTypeExtension): TSPPPluginDisposer;
}

export interface TSPPCompilerHostAPI {
    registerInterfaceMemberContract(pluginId: string, contract: TSPPInterfaceMemberContract): TSPPPluginDisposer;
    registerProgramAnalyzer(pluginId: string, analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(pluginId: string, preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerExpressionRewriter(pluginId: string, rewriter: TSPPExpressionRewriter): TSPPPluginDisposer;
    registerProgramRebuilder(pluginId: string, rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
    registerSyntaxExtension(pluginId: string, extension: TSPPSyntaxExtension): TSPPPluginDisposer;
    registerDiagnosticProvider(pluginId: string, provider: TSPPDiagnosticProvider): TSPPPluginDisposer;
    registerTypeExtension(pluginId: string, extension: TSPPTypeExtension): TSPPPluginDisposer;
}

/** The public TypeScript API of the host compiler. Plugins use it instead of importing their own `typescript`. */
export type TSPPTypeScript = typeof import("typescript-upstream");

export interface TSPPCompilerPluginContext {
    readonly compilerVersion: string;
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;
    /** The host compiler's public API, so plugins share its parser, checker, factory, and syntax kinds. */
    readonly ts: TSPPTypeScript;
    readonly compiler: TSPPCompilerPluginAPI;
    readonly dependencies: TSPPPluginDependencies;
    /** Publishes an API declared in the manifest's `provides` for plugins that depend on this one. */
    provide(name: string, api: unknown): void;
    onDispose(disposer: TSPPPluginDisposer): void;
}

export interface TSPPCompilerPlugin {
    activate(context: TSPPCompilerPluginContext): void | TSPPPluginDisposer;
}
