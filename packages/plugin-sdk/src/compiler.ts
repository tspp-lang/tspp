import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

/** Opaque compiler values prevent plugins from depending on compiler internals. */
export type TSPPSyntaxNode = object;
export type TSPPExpression = TSPPSyntaxNode;
export type TSPPVariableDeclarationList = TSPPSyntaxNode;
export type TSPPDeclaration = TSPPSyntaxNode;
export type TSPPCallExpression = TSPPExpression;
export type TSPPIdentifier = TSPPSyntaxNode;
export type TSPPTypeNode = TSPPSyntaxNode;
export type TSPPTypeParameterList = TSPPSyntaxNode;
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

export interface TSPPProgramAnalyzer {
    readonly id: string;
    analyze(input: TSPPProgramAnalysisInput): Promise<readonly TSPPAnalysisDiagnostic[]>;
}

export interface TSPPSourcePreprocessor {
    readonly id: string;
    /** Must return text with exactly the same UTF-16 length and line breaks. */
    preprocess(fileName: string, sourceText: string): string;
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
    readonly inKeyword: TSPPSyntaxKind;
    readonly letKeyword: TSPPSyntaxKind;
}

export interface TSPPExpressionParser {
    readonly kinds: TSPPExpressionSyntaxKinds;
    token(): TSPPSyntaxKind;
    nextToken(): TSPPSyntaxKind;
    hasPrecedingLineBreak(): boolean;
    lookAhead<T>(callback: () => T): T;
    getNodePos(): number;
    parseExpected(kind: TSPPSyntaxKind): boolean;
    parseVariableDeclarationList(inForStatementInitializer: boolean): TSPPVariableDeclarationList;
    parseAssignmentExpression(): TSPPExpression;
    finishExpression(children: readonly TSPPSyntaxNode[], pos: number): TSPPExtensionExpression;
}

export interface TSPPExpressionChecker {
    checkExpression(node: TSPPExpression, checkMode: number | undefined): TSPPType;
    checkVariableDeclarationList(node: TSPPVariableDeclarationList): void;
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
}

export interface TSPPExpressionSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPExpressionParser): boolean;
    parse(parser: TSPPExpressionParser): TSPPExtensionExpression;
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
}

export interface TSPPDeclarationChecker {
    getTypeNode(node: TSPPDeclaration): TSPPTypeNode;
    getTypeFromTypeNode(node: TSPPTypeNode): TSPPType;
    getDeclaredType(node: TSPPDeclaration): TSPPType;
    createNominalType(node: TSPPDeclaration, underlyingType: TSPPType): TSPPType;
    createIdentityConstructorType(node: TSPPDeclaration, parameterType: TSPPType, returnType: TSPPType): TSPPType;
}

export interface TSPPDeclarationTransformer {
    createNotEmittedStatement(node: TSPPDeclaration): TSPPSyntaxNode;
}

export interface TSPPDeclarationCallTransformer {
    getArguments(node: TSPPCallExpression): readonly TSPPExpression[];
    visitExpression(node: TSPPExpression): TSPPExpression;
}

export interface TSPPDeclarationEmitter {
    emitTypeAliasDeclaration(node: TSPPDeclaration, keyword: string): void;
}

export interface TSPPDeclarationSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    readonly binding: "type" | "type-and-value";
    /** Controls whether imports that only reference this declaration need a JavaScript binding. */
    readonly runtime?: "emitted" | "erased";
    isStart(parser: TSPPDeclarationParser): boolean;
    parse(parser: TSPPDeclarationParser): TSPPDeclaration;
    getDeclaredType?(node: TSPPDeclaration, checker: TSPPDeclarationChecker, underlyingType: TSPPType): TSPPType;
    getValueType?(node: TSPPDeclaration, checker: TSPPDeclarationChecker): TSPPType;
    transform?(node: TSPPDeclaration, transformer: TSPPDeclarationTransformer): TSPPSyntaxNode;
    transformCall?(
        node: TSPPCallExpression,
        declaration: TSPPDeclaration,
        transformer: TSPPDeclarationCallTransformer,
    ): TSPPExpression;
    emitDeclaration?(node: TSPPDeclaration, emitter: TSPPDeclarationEmitter): void;
}

export interface TSPPCompilerPluginAPI {
    readonly expressionSyntaxKinds: TSPPExpressionSyntaxKinds;
    readonly declarationSyntaxKinds: TSPPDeclarationSyntaxKinds;
    registerExpressionSyntax(syntax: TSPPExpressionSyntax): TSPPPluginDisposer;
    registerDeclarationSyntax(syntax: TSPPDeclarationSyntax): TSPPPluginDisposer;
    registerProgramAnalyzer(analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
}

export interface TSPPCompilerHostAPI {
    readonly expressionSyntaxKinds: TSPPExpressionSyntaxKinds;
    readonly declarationSyntaxKinds: TSPPDeclarationSyntaxKinds;
    registerExpressionSyntax(pluginId: string, syntax: TSPPExpressionSyntax): TSPPPluginDisposer;
    registerDeclarationSyntax(pluginId: string, syntax: TSPPDeclarationSyntax): TSPPPluginDisposer;
    registerProgramAnalyzer(pluginId: string, analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(pluginId: string, preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
}

export interface TSPPCompilerPluginContext {
    readonly compilerVersion: string;
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;
    readonly compiler: TSPPCompilerPluginAPI;
    onDispose(disposer: TSPPPluginDisposer): void;
}

export interface TSPPCompilerPlugin {
    activate(context: TSPPCompilerPluginContext): void | TSPPPluginDisposer;
}
