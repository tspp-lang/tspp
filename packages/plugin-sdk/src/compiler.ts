import type { TSPPPluginDependencies, TSPPPluginDisposer, TSPPPluginLogger } from "./index";

/** Opaque compiler values prevent plugins from depending on compiler internals. */
export type TSPPSyntaxNode = object;
export type TSPPIdentifier = TSPPSyntaxNode;
export type TSPPTypeNode = TSPPSyntaxNode;
export type TSPPTypeParameterList = TSPPSyntaxNode;
export type TSPPSyntaxKind = number;

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
 * Where plugin syntax may start: a unary expression, a statement, a function body after its signature, or a
 * declaration, which may follow modifiers such as `export`.
 */
export type TSPPSyntaxExtensionPosition = "expression" | "statement" | "function-body" | "declaration";

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
     * Returns an expression, a statement, or a function body block, matching `position`. A statement or declaration
     * may stand for several statements; the parser places the rest after the first in the enclosing list.
     */
    parse(cursor: TSPPSyntaxCursor): import("typescript-upstream").Node | readonly import("typescript-upstream").Statement[];
    /**
     * The text of a statement this syntax produced in feature-rich `.d.tspp` output, such as the authored
     * declaration; an empty string omits the statement. `statement` is the declaration emitter's node.
     */
    restoreDeclaration?(statement: import("typescript-upstream").Statement): string | undefined;
}

/** Semantic diagnostics a plugin adds to each source file; comment directives such as `@ts-expect-error` apply. */
export interface TSPPDiagnosticProvider {
    readonly id: string;
    getSemanticDiagnostics(
        sourceFile: import("typescript-upstream").SourceFile,
        checker: import("typescript-upstream").TypeChecker,
    ): readonly import("typescript-upstream").Diagnostic[];
    /** Return false to drop a diagnostic the checker reported, for example one about code this plugin generated. */
    filterDiagnostic?(diagnostic: import("typescript-upstream").Diagnostic): boolean;
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

export interface TSPPTypeSyntaxKinds {
    readonly endOfFileToken: TSPPSyntaxKind;
    readonly identifier: TSPPSyntaxKind;
    readonly letKeyword: TSPPSyntaxKind;
    readonly inKeyword: TSPPSyntaxKind;
    readonly inferKeyword: TSPPSyntaxKind;
    readonly lessThanToken: TSPPSyntaxKind;
    readonly greaterThanToken: TSPPSyntaxKind;
    readonly equalsToken: TSPPSyntaxKind;
    readonly equalsGreaterThanToken: TSPPSyntaxKind;
    readonly openBraceToken: TSPPSyntaxKind;
    readonly closeBraceToken: TSPPSyntaxKind;
    readonly colonToken: TSPPSyntaxKind;
    readonly commaToken: TSPPSyntaxKind;
    readonly semicolonToken: TSPPSyntaxKind;
    readonly openParenToken: TSPPSyntaxKind;
    readonly closeParenToken: TSPPSyntaxKind;
}

export type TSPPTypeKind = TSPPOrdinaryTypeKind | TSPPFunctionTypeKind;

export interface TSPPOrdinaryTypeKind {
    readonly kind: "type";
    readonly level: number;
}

export interface TSPPFunctionTypeKind {
    readonly kind: "function";
    readonly parameters: readonly TSPPTypeKind[];
    readonly result: TSPPTypeKind;
}

export interface TSPPKindAnnotationParser {
    readonly kinds: TSPPTypeSyntaxKinds;
    token(): TSPPSyntaxKind;
    tokenText(): string;
    nextToken(): TSPPSyntaxKind;
    parseExpected(kind: TSPPSyntaxKind): boolean;
}

/** Plugin-owned kind annotation following a type declaration or type parameter name. */
export interface TSPPKindAnnotationSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPKindAnnotationParser): boolean;
    parse(parser: TSPPKindAnnotationParser): TSPPTypeKind;
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

export interface TSPPTypeMatchArm {
    readonly pattern: TSPPTypeNode;
    readonly result: TSPPTypeNode;
}

export interface TSPPTypeParser {
    readonly kinds: TSPPTypeSyntaxKinds;
    token(): TSPPSyntaxKind;
    tokenText(): string;
    nextToken(): TSPPSyntaxKind;
    hasPrecedingLineBreak(): boolean;
    lookAhead<T>(callback: () => T): T;
    getNodePos(): number;
    parseExpected(kind: TSPPSyntaxKind): boolean;
    parseIdentifier(): TSPPIdentifier;
    parseTypeParameters(): TSPPTypeParameterList | undefined;
    parseType(): TSPPTypeNode;
    parseTypeMatchPattern(): TSPPTypeNode;
    finishScopedTypeBinding(
        name: TSPPIdentifier,
        value: TSPPTypeNode,
        body: TSPPTypeNode,
        pos: number,
    ): TSPPTypeNode;
    finishOrderedTypeMatch(
        scrutinee: TSPPTypeNode,
        arms: readonly TSPPTypeMatchArm[],
        pos: number,
    ): TSPPTypeNode;
    finishTypeConstructor(
        typeParameters: TSPPTypeParameterList,
        body: TSPPTypeNode,
        pos: number,
    ): TSPPTypeNode;
    finishTypeUniverse(level: number, pos: number): TSPPTypeNode;
}

/** Plugin-owned syntax in a type position, lowered through generic type operations. */
export interface TSPPTypeSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    /** Preserve the authored spelling in feature-rich `.d.tspp` declarations. */
    readonly preserveDeclarationText?: boolean;
    isStart(parser: TSPPTypeParser): boolean;
    parse(parser: TSPPTypeParser): TSPPTypeNode;
}

export interface TSPPPostfixTypeParser {
    readonly kinds: TSPPTypeSyntaxKinds;
    token(): TSPPSyntaxKind;
    getNodePos(): number;
    parseTypeArguments(): readonly TSPPTypeNode[] | undefined;
    finishTypeApplication(target: TSPPTypeNode, typeArguments: readonly TSPPTypeNode[], pos: number): TSPPTypeNode;
}

/** Plugin-owned syntax applied after an already parsed type. */
export interface TSPPPostfixTypeSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPPostfixTypeParser): boolean;
    parse(target: TSPPTypeNode, parser: TSPPPostfixTypeParser): TSPPTypeNode;
}

export interface TSPPCompilerPluginAPI {
    readonly typeSyntaxKinds: TSPPTypeSyntaxKinds;
    registerTypeSyntax(syntax: TSPPTypeSyntax): TSPPPluginDisposer;
    registerPostfixTypeSyntax(syntax: TSPPPostfixTypeSyntax): TSPPPluginDisposer;
    registerKindAnnotationSyntax(syntax: TSPPKindAnnotationSyntax): TSPPPluginDisposer;
    registerInterfaceMemberContract(contract: TSPPInterfaceMemberContract): TSPPPluginDisposer;
    registerProgramAnalyzer(analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerExpressionRewriter(rewriter: TSPPExpressionRewriter): TSPPPluginDisposer;
    registerProgramRebuilder(rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
    registerSyntaxExtension(extension: TSPPSyntaxExtension): TSPPPluginDisposer;
    registerDiagnosticProvider(provider: TSPPDiagnosticProvider): TSPPPluginDisposer;
}

export interface TSPPCompilerHostAPI {
    readonly typeSyntaxKinds: TSPPTypeSyntaxKinds;
    registerTypeSyntax(pluginId: string, syntax: TSPPTypeSyntax): TSPPPluginDisposer;
    registerPostfixTypeSyntax(pluginId: string, syntax: TSPPPostfixTypeSyntax): TSPPPluginDisposer;
    registerKindAnnotationSyntax(pluginId: string, syntax: TSPPKindAnnotationSyntax): TSPPPluginDisposer;
    registerInterfaceMemberContract(pluginId: string, contract: TSPPInterfaceMemberContract): TSPPPluginDisposer;
    registerProgramAnalyzer(pluginId: string, analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(pluginId: string, preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerExpressionRewriter(pluginId: string, rewriter: TSPPExpressionRewriter): TSPPPluginDisposer;
    registerProgramRebuilder(pluginId: string, rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
    registerSyntaxExtension(pluginId: string, extension: TSPPSyntaxExtension): TSPPPluginDisposer;
    registerDiagnosticProvider(pluginId: string, provider: TSPPDiagnosticProvider): TSPPPluginDisposer;
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
