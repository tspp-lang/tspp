import type { TSPPPluginDependencies, TSPPPluginDisposer, TSPPPluginLogger } from "./index";

/** Opaque compiler values prevent plugins from depending on compiler internals. */
export type TSPPSyntaxNode = object;
export type TSPPExpression = TSPPSyntaxNode;
export type TSPPBlock = TSPPSyntaxNode;
export type TSPPVariableDeclarationList = TSPPSyntaxNode;
export type TSPPBindingName = TSPPSyntaxNode;
export type TSPPStatement = TSPPSyntaxNode;
export type TSPPDeclaration = TSPPSyntaxNode;
export type TSPPCallExpression = TSPPExpression;
export type TSPPIdentifier = TSPPSyntaxNode;
export type TSPPTypeNode = TSPPSyntaxNode;
export type TSPPTypeParameterList = TSPPSyntaxNode;
export type TSPPTaggedUnionStatement = TSPPSyntaxNode;
export type TSPPType = object;
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
    /** Replacements by file name. Each covers one statement of the original program, matched by its start and end. */
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

export interface TSPPExtensionExpression {
    readonly pluginId: string;
    readonly extensionChildren: readonly TSPPSyntaxNode[];
}

export interface TSPPExpressionSyntaxKinds {
    readonly endOfFileToken: TSPPSyntaxKind;
    readonly identifier: TSPPSyntaxKind;
    readonly openBracketToken: TSPPSyntaxKind;
    readonly closeBracketToken: TSPPSyntaxKind;
    readonly openBraceToken: TSPPSyntaxKind;
    readonly closeBraceToken: TSPPSyntaxKind;
    readonly openParenToken: TSPPSyntaxKind;
    readonly closeParenToken: TSPPSyntaxKind;
    readonly semicolonToken: TSPPSyntaxKind;
    readonly commaToken: TSPPSyntaxKind;
    readonly equalsToken: TSPPSyntaxKind;
    readonly colonToken: TSPPSyntaxKind;
    readonly lessThanToken: TSPPSyntaxKind;
    readonly minusToken: TSPPSyntaxKind;
    readonly equalsGreaterThanToken: TSPPSyntaxKind;
    readonly inKeyword: TSPPSyntaxKind;
    readonly letKeyword: TSPPSyntaxKind;
    readonly doKeyword: TSPPSyntaxKind;
    readonly whileKeyword: TSPPSyntaxKind;
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

export interface TSPPExpressionParser {
    readonly kinds: TSPPExpressionSyntaxKinds;
    token(): TSPPSyntaxKind;
    tokenText(): string;
    nextToken(): TSPPSyntaxKind;
    hasPrecedingLineBreak(): boolean;
    lookAhead<T>(callback: () => T): T;
    getNodePos(): number;
    parseExpected(kind: TSPPSyntaxKind): boolean;
    parseVariableDeclarationList(inForStatementInitializer: boolean): TSPPVariableDeclarationList;
    parseType(): TSPPTypeNode;
    parseAssignmentExpression(): TSPPExpression;
    parseBlock(): TSPPBlock;
    parseTaggedUnionMatchExpression(): TSPPExpression;
    finishExpression(children: readonly TSPPSyntaxNode[], pos: number): TSPPExtensionExpression;
}

export interface TSPPExpressionChecker {
    checkExpression(node: TSPPExpression, checkMode: number | undefined): TSPPType;
    /** `requireInitializers` reports each binding without an initializer, which the list syntax alone allows. */
    checkVariableDeclarationList(
        node: TSPPVariableDeclarationList,
        options?: { readonly requireInitializers?: boolean; },
    ): void;
    checkTaggedUnionMatch(node: TSPPExtensionExpression, checkMode: number | undefined): TSPPType;
    checkCompletionBlock(block: TSPPBlock, checkMode: number | undefined): TSPPType;
    /** Creates an opaque runtime descriptor type that retains its represented static type. */
    createReifiedType(type: TSPPTypeNode): TSPPType;
    checkReifiedTypeMatch(
        owner: TSPPExtensionExpression,
        scrutinee: TSPPExpression,
        arms: readonly TSPPReifiedTypeMatchArm[],
        checkMode: number | undefined,
    ): TSPPType;
}

export interface TSPPReifiedTypeMatchArm {
    /** Missing only for the required final wildcard arm. */
    readonly pattern?: TSPPTypeNode;
    readonly result: TSPPExpression;
}

export interface TSPPExpressionTransformer {
    visitExpression(node: TSPPExpression): TSPPExpression;
    visitVariableDeclarationList(node: TSPPVariableDeclarationList): TSPPVariableDeclarationList;
    createVariableStatement(declarations: TSPPVariableDeclarationList): TSPPSyntaxNode;
    createReturnStatement(expression: TSPPExpression): TSPPSyntaxNode;
    createBlock(statements: readonly TSPPSyntaxNode[], multiLine: boolean): TSPPSyntaxNode;
    createArrowFunction(body: TSPPSyntaxNode): TSPPExpression;
    createParenthesizedExpression(expression: TSPPExpression): TSPPExpression;
    createCallExpression(expression: TSPPExpression): TSPPExpression;
    createCompletionBlockIIFE(block: TSPPBlock): TSPPExpression;
    /** Emits a serializable runtime descriptor for an authored type node. */
    createReifiedTypeDescriptor(type: TSPPTypeNode): TSPPExpression;
    getSelectedExpression(owner: TSPPExtensionExpression): TSPPExpression;
}

export interface TSPPFunctionBodyParser {
    readonly kinds: TSPPExpressionSyntaxKinds;
    token(): TSPPSyntaxKind;
    nextToken(): TSPPSyntaxKind;
    lookAhead<T>(callback: () => T): T;
    parseExpected(kind: TSPPSyntaxKind): boolean;
    parseBlock(): TSPPBlock;
}

/** A plugin-owned prefix that turns a normal function block into a completion-valued body. */
export interface TSPPFunctionBodySyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPFunctionBodyParser): boolean;
    parse(parser: TSPPFunctionBodyParser): TSPPBlock;
    readonly completion: "implicit-return";
}

export interface TSPPStatementParser {
    readonly kinds: TSPPExpressionSyntaxKinds;
    token(): TSPPSyntaxKind;
    tokenText(): string;
    nextToken(): TSPPSyntaxKind;
    hasPrecedingLineBreak(): boolean;
    lookAhead<T>(callback: () => T): T;
    getNodePos(): number;
    parseExpected(kind: TSPPSyntaxKind): boolean;
    parseBindingName(): TSPPBindingName;
    parseTypeAnnotation(): TSPPTypeNode | undefined;
    parseExpression(): TSPPExpression;
    parseSemicolon(): boolean;
    finishTrailingClosureBinding(
        name: TSPPBindingName,
        type: TSPPTypeNode | undefined,
        target: TSPPExpression,
        pos: number,
    ): TSPPStatement;
}

/** A statement lowered by passing the remainder of its completion block as a trailing closure. */
export interface TSPPTrailingClosureBindingSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPStatementParser): boolean;
    parse(parser: TSPPStatementParser): TSPPStatement;
}

export interface TSPPDeepReadonlyBindingParser {
    readonly kinds: TSPPExpressionSyntaxKinds;
    token(): TSPPSyntaxKind;
    tokenText(): string;
    nextToken(): TSPPSyntaxKind;
    hasPrecedingLineBreak(): boolean;
    lookAhead<T>(callback: () => T): T;
    getNodePos(): number;
    finishDeepReadonlyBinding(pos: number): TSPPStatement;
}

/** A plugin-owned declaration with const binding and recursive const-context inference. */
export interface TSPPDeepReadonlyBindingSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPDeepReadonlyBindingParser): boolean;
    parse(parser: TSPPDeepReadonlyBindingParser): TSPPStatement;
}

export interface TSPPExpressionSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPExpressionParser): boolean;
    parse(parser: TSPPExpressionParser): TSPPExpression;
    check(node: TSPPExtensionExpression, checker: TSPPExpressionChecker, checkMode: number | undefined): TSPPType;
    transform(node: TSPPExtensionExpression, transformer: TSPPExpressionTransformer): TSPPExpression;
}

export interface TSPPDeclarationParser {
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
    parseSemicolon(): boolean;
    /** Reports a plugin-authored syntax error at the current token. */
    parseErrorAtCurrentToken(message: string): void;
    finishTaggedUnionDeclaration(
        name: TSPPIdentifier,
        typeParameters: TSPPTypeParameterList | undefined,
        variants: readonly TSPPTaggedUnionVariant[],
        pos: number,
    ): TSPPDeclaration;
    finishTypeAliasDeclaration(
        name: TSPPIdentifier,
        typeParameters: TSPPTypeParameterList | undefined,
        type: TSPPTypeNode,
        pos: number,
    ): TSPPDeclaration;
}

export interface TSPPDeclarationSyntaxKinds {
    readonly identifier: TSPPSyntaxKind;
    readonly equalsToken: TSPPSyntaxKind;
    readonly barToken: TSPPSyntaxKind;
    readonly openParenToken: TSPPSyntaxKind;
    readonly closeParenToken: TSPPSyntaxKind;
    readonly commaToken: TSPPSyntaxKind;
    readonly colonToken: TSPPSyntaxKind;
}

export interface TSPPTaggedUnionField {
    readonly name: TSPPIdentifier;
    readonly type: TSPPTypeNode;
}

export interface TSPPTaggedUnionVariant {
    readonly name: TSPPIdentifier;
    readonly fields: readonly TSPPTaggedUnionField[];
}

export interface TSPPDeclarationChecker {
    getTypeNode(node: TSPPDeclaration): TSPPTypeNode;
    getTypeFromTypeNode(node: TSPPTypeNode): TSPPType;
    getDeclaredType(node: TSPPDeclaration): TSPPType;
    createNominalType(node: TSPPDeclaration, underlyingType: TSPPType): TSPPType;
    createIdentityConstructorType(node: TSPPDeclaration, parameterType: TSPPType, returnType: TSPPType): TSPPType;
    createTaggedUnionConstructorType(node: TSPPDeclaration): TSPPType;
}

export interface TSPPDeclarationTransformer {
    createNotEmittedStatement(node: TSPPDeclaration): TSPPSyntaxNode;
    createTaggedUnionStatements(node: TSPPDeclaration): readonly TSPPTaggedUnionStatement[];
}

export interface TSPPDeclarationCallTransformer {
    getArguments(node: TSPPCallExpression): readonly TSPPExpression[];
    visitExpression(node: TSPPExpression): TSPPExpression;
}

export interface TSPPDeclarationEmitter {
    emitTypeAliasDeclaration(node: TSPPDeclaration, keyword: string): void;
    emitTaggedUnionDeclaration(node: TSPPDeclaration, keyword: string): void;
    /** Emits an erased nominal alias plus its value constructor for upstream TypeScript. */
    emitCompatibilityNominalDeclaration(node: TSPPDeclaration): void;
    /** Emits a tagged union and its constructors using ordinary TypeScript declarations. */
    emitCompatibilityTaggedUnionDeclaration(node: TSPPDeclaration): void;
}

export interface TSPPDeclarationSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    readonly binding: "type" | "type-and-value";
    /** Controls whether imports that only reference this declaration need a JavaScript binding. */
    readonly runtime?: "emitted" | "erased";
    /** Restricts an erased value to direct calls so it cannot escape into emitted JavaScript. */
    readonly valueUse?: "unrestricted" | "call-only";
    isStart(parser: TSPPDeclarationParser): boolean;
    parse(parser: TSPPDeclarationParser): TSPPDeclaration;
    getDeclaredType?(node: TSPPDeclaration, checker: TSPPDeclarationChecker, underlyingType: TSPPType): TSPPType;
    getValueType?(node: TSPPDeclaration, checker: TSPPDeclarationChecker): TSPPType;
    transform?(
        node: TSPPDeclaration,
        transformer: TSPPDeclarationTransformer,
    ): TSPPSyntaxNode | readonly TSPPSyntaxNode[];
    transformCall?(
        node: TSPPCallExpression,
        declaration: TSPPDeclaration,
        transformer: TSPPDeclarationCallTransformer,
    ): TSPPExpression;
    emitDeclaration?(node: TSPPDeclaration, emitter: TSPPDeclarationEmitter): void;
    /** Projects this declaration onto syntax accepted by upstream TypeScript. */
    emitCompatibilityDeclaration?(node: TSPPDeclaration, emitter: TSPPDeclarationEmitter): void;
}

export interface TSPPCompilerPluginAPI {
    readonly expressionSyntaxKinds: TSPPExpressionSyntaxKinds;
    readonly declarationSyntaxKinds: TSPPDeclarationSyntaxKinds;
    readonly typeSyntaxKinds: TSPPTypeSyntaxKinds;
    registerExpressionSyntax(syntax: TSPPExpressionSyntax): TSPPPluginDisposer;
    registerFunctionBodySyntax(syntax: TSPPFunctionBodySyntax): TSPPPluginDisposer;
    registerTrailingClosureBindingSyntax(syntax: TSPPTrailingClosureBindingSyntax): TSPPPluginDisposer;
    registerDeepReadonlyBindingSyntax(syntax: TSPPDeepReadonlyBindingSyntax): TSPPPluginDisposer;
    registerDeclarationSyntax(syntax: TSPPDeclarationSyntax): TSPPPluginDisposer;
    registerTypeSyntax(syntax: TSPPTypeSyntax): TSPPPluginDisposer;
    registerPostfixTypeSyntax(syntax: TSPPPostfixTypeSyntax): TSPPPluginDisposer;
    registerKindAnnotationSyntax(syntax: TSPPKindAnnotationSyntax): TSPPPluginDisposer;
    registerInterfaceMemberContract(contract: TSPPInterfaceMemberContract): TSPPPluginDisposer;
    registerProgramAnalyzer(analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerExpressionRewriter(rewriter: TSPPExpressionRewriter): TSPPPluginDisposer;
    registerProgramRebuilder(rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
}

export interface TSPPCompilerHostAPI {
    readonly expressionSyntaxKinds: TSPPExpressionSyntaxKinds;
    readonly declarationSyntaxKinds: TSPPDeclarationSyntaxKinds;
    readonly typeSyntaxKinds: TSPPTypeSyntaxKinds;
    registerExpressionSyntax(pluginId: string, syntax: TSPPExpressionSyntax): TSPPPluginDisposer;
    registerFunctionBodySyntax(pluginId: string, syntax: TSPPFunctionBodySyntax): TSPPPluginDisposer;
    registerTrailingClosureBindingSyntax(pluginId: string, syntax: TSPPTrailingClosureBindingSyntax): TSPPPluginDisposer;
    registerDeepReadonlyBindingSyntax(pluginId: string, syntax: TSPPDeepReadonlyBindingSyntax): TSPPPluginDisposer;
    registerDeclarationSyntax(pluginId: string, syntax: TSPPDeclarationSyntax): TSPPPluginDisposer;
    registerTypeSyntax(pluginId: string, syntax: TSPPTypeSyntax): TSPPPluginDisposer;
    registerPostfixTypeSyntax(pluginId: string, syntax: TSPPPostfixTypeSyntax): TSPPPluginDisposer;
    registerKindAnnotationSyntax(pluginId: string, syntax: TSPPKindAnnotationSyntax): TSPPPluginDisposer;
    registerInterfaceMemberContract(pluginId: string, contract: TSPPInterfaceMemberContract): TSPPPluginDisposer;
    registerProgramAnalyzer(pluginId: string, analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(pluginId: string, preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerExpressionRewriter(pluginId: string, rewriter: TSPPExpressionRewriter): TSPPPluginDisposer;
    registerProgramRebuilder(pluginId: string, rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
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
