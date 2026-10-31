import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

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
}

/** Plugin-owned syntax in a type position, lowered through generic type operations. */
export interface TSPPTypeSyntax {
    readonly startTokens: readonly TSPPSyntaxKind[];
    isStart(parser: TSPPTypeParser): boolean;
    parse(parser: TSPPTypeParser): TSPPTypeNode;
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
    parseAssignmentExpression(): TSPPExpression;
    parseBlock(): TSPPBlock;
    parseTaggedUnionMatchExpression(): TSPPExpression;
    finishExpression(children: readonly TSPPSyntaxNode[], pos: number): TSPPExtensionExpression;
}

export interface TSPPExpressionChecker {
    checkExpression(node: TSPPExpression, checkMode: number | undefined): TSPPType;
    checkVariableDeclarationList(node: TSPPVariableDeclarationList): void;
    checkTaggedUnionMatch(node: TSPPExtensionExpression, checkMode: number | undefined): TSPPType;
    checkCompletionBlock(block: TSPPBlock, checkMode: number | undefined): TSPPType;
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
    registerProgramAnalyzer(analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
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
