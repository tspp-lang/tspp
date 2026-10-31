import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

/** Opaque compiler values prevent plugins from depending on compiler internals. */
export type TSPPSyntaxNode = object;
export type TSPPExpression = TSPPSyntaxNode;
export type TSPPVariableDeclarationList = TSPPSyntaxNode;
export type TSPPType = object;
export type TSPPSyntaxKind = number;

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

export interface TSPPCompilerPluginAPI {
    readonly expressionSyntaxKinds: TSPPExpressionSyntaxKinds;
    registerExpressionSyntax(syntax: TSPPExpressionSyntax): TSPPPluginDisposer;
}

export interface TSPPCompilerHostAPI {
    readonly expressionSyntaxKinds: TSPPExpressionSyntaxKinds;
    registerExpressionSyntax(pluginId: string, syntax: TSPPExpressionSyntax): TSPPPluginDisposer;
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
