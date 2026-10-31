/** The only plugin contract version understood by this first host. */
export const TSPP_PLUGIN_API_VERSION = 1 as const;

export interface TSPPPluginManifest {
    /** Stable, repository-wide identity such as `modern-syntax/let-in`. */
    readonly id: string;
    /** Version of the plugin package, not the compiler. */
    readonly version: string;
    /** Exact SDK contract expected by the plugin. */
    readonly apiVersion: typeof TSPP_PLUGIN_API_VERSION;
    readonly displayName?: string;
}

export interface TSPPPluginLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export type TSPPPluginDisposer = () => void;

/**
 * Opaque compiler values. Plugins can pass these values between capability
 * ports, but cannot depend on the compiler's internal AST representation.
 */
export type TSPPSyntaxNode = object;
export type TSPPExpression = TSPPSyntaxNode;
export type TSPPVariableDeclarationList = TSPPSyntaxNode;
export type TSPPType = object;
export type TSPPSyntaxKind = number;

export interface TSPPExtensionExpression {
    readonly pluginId: string;
    readonly extensionChildren: readonly TSPPSyntaxNode[];
}

/** Syntax kinds exposed to expression plugins by name instead of copied enum values. */
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

/** A deliberately narrow lowering surface; new operations require a real plugin consumer. */
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

/** One expression-shaped syntax capsule registered by a plugin. */
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

/** Host-side counterpart that binds registrations to the activating plugin. */
export interface TSPPCompilerHostAPI {
    readonly expressionSyntaxKinds: TSPPExpressionSyntaxKinds;
    registerExpressionSyntax(pluginId: string, syntax: TSPPExpressionSyntax): TSPPPluginDisposer;
}

export interface TSPPPluginContext {
    readonly compilerVersion: string;
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;
    readonly compiler: TSPPCompilerPluginAPI;

    /** Registers process-lifetime cleanup owned by this plugin. */
    onDispose(disposer: TSPPPluginDisposer): void;
}

/**
 * A statically linked TSPP plugin.
 *
 * Compiler hook ports intentionally do not exist yet. They will be added to the
 * context only when the first real plugin proves what the boundary must expose.
 */
export interface TSPPPlugin {
    readonly manifest: TSPPPluginManifest;
    activate(context: TSPPPluginContext): void | TSPPPluginDisposer;
}

/** Gives plugin packages contextual typing without wrapping or mutating them. */
export function definePlugin<const T extends TSPPPlugin>(plugin: T): T {
    return plugin;
}
