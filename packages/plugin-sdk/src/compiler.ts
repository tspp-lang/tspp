import type { TSPPPluginDependencies, TSPPPluginDisposer, TSPPPluginLogger, TSPPSyntaxKeyword, TSPPSyntaxPosition } from "./index";

/** The authored text of a source file, as supplied to background analyzers. */
export interface TSPPAnalysisSourceFile {
    readonly fileName: string;
    readonly text: string;
    /**
     * What the type checker resolved each call and `new` expression of the file to, when an analyzer asked for it
     * with `needsCallTargets`. Calls that syntax plugins generated, and calls whose callee resolves to nothing, are
     * left out.
     */
    readonly callTargets?: readonly TSPPAnalysisCallTarget[];
    /**
     * The classes each class of the file extends, when an analyzer asked for it with `needsClassAncestry`: class
     * declarations and expressions alike, nested ones included.
     */
    readonly classAncestry?: readonly TSPPAnalysisClassAncestry[];
}

/**
 * A class, by its range in the file, with the declarations of the classes it extends: its base first, then that
 * class's base, in whichever files they are declared. `complete` is false when a base could not be followed to a class
 * declaration, as with `extends mixin(Base)`, so classes further up may be missing.
 */
export interface TSPPAnalysisClassAncestry {
    readonly start: number;
    readonly end: number;
    readonly ancestors: readonly TSPPAnalysisLocation[];
    readonly complete: boolean;
}

/** A range of a source file's authored text: from a node's first token to its end. */
export interface TSPPAnalysisLocation {
    readonly fileName: string;
    readonly start: number;
    readonly end: number;
}

/**
 * A call or `new` expression, by its range in the file, with the declarations of the symbol its callee names: a
 * function's or method's overloads and implementation, every member of a union that declares the method, or the
 * class a `new` creates. An analyzer must not assume which one runs when there are several.
 */
export interface TSPPAnalysisCallTarget {
    readonly start: number;
    readonly end: number;
    readonly declarations: readonly TSPPAnalysisLocation[];
}

export interface TSPPProgramAnalysisInput {
    readonly currentDirectory: string;
    readonly rootFileNames: readonly string[];
    readonly sourceFiles: readonly TSPPAnalysisSourceFile[];
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
    /**
     * Asks the host to resolve the calls of every source file with the type checker, as `callTargets`. Analyzers still
     * receive no compiler objects; the host only adds ranges.
     */
    readonly needsCallTargets?: boolean;
    /** Asks the host to follow each class's `extends` chain with the type checker, as `classAncestry`. */
    readonly needsClassAncestry?: boolean;
    analyze(input: TSPPProgramAnalysisInput): Promise<TSPPProgramAnalysisOutput>;
}

/**
 * Rewrites a `.tspp` file before it is parsed. Every preprocessor receives the authored text, whatever the others do;
 * the host merges their results and reports a diagnostic where two rewrite the same text differently. Search the text
 * through `maskNonCode`, so that strings and comments stay as they are.
 */
export interface TSPPSourcePreprocessor {
    readonly id: string;
    /** The syntax this preprocessor handles, which two plugins may not share. */
    readonly claims: readonly TSPPSyntaxKeyword[];
    /** Must return text with exactly the same UTF-16 length and line breaks. */
    preprocess(fileName: string, sourceText: string): string;
    /**
     * Restores a type alias owned by this preprocessor for feature-rich
     * `.d.tspp` output. Compatibility `.d.ts` output continues to use the
     * projected syntax seen by TypeScript.
     */
    /** Restores a preprocessed clause after a function's parameters for `.d.tspp` output. */
    restoreFunctionClause?(request: TSPPPreprocessedFunctionRequest): string | undefined;
    /** Restores preprocessed syntax written before a function's `function` keyword for `.d.tspp` output. */
    restoreFunctionPrefix?(request: TSPPPreprocessedFunctionRequest): string | undefined;
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
    /**
     * The module paths of the active plugins, in activation order. A rebuilder that parses in another thread loads them
     * there, so it reads every plugin's syntax. Undefined when some active plugin cannot be loaded again.
     */
    readonly pluginModulePaths?: readonly string[];
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
    /** Return false to drop a semantic or suggestion diagnostic of the rebuilt program, or a diagnostic to report in its place. */
    filterDiagnostic?(diagnostic: import("typescript-upstream").Diagnostic): boolean | import("typescript-upstream").Diagnostic;
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
 * Where plugin syntax may start: a unary expression, a primary expression (which calls and member accesses may follow,
 * and which prefix operators apply to), a call argument, a statement, a function body after its signature, a
 * declaration, which may follow modifiers such as `export`, a type, the continuation of an already parsed type
 * (`precedingType`), or an annotation after a type parameter's name, after a type alias's name and type parameters,
 * after the parameters of a signature with a return type (`function-clause`), or after the type parameters of a class or
 * interface (`header-clause`).
 */
export type TSPPSyntaxExtensionPosition =
    | "expression"
    | "primary-expression"
    | "argument"
    | "statement"
    | "function-body"
    | "declaration"
    | "type"
    | "postfix-type"
    | "type-parameter-annotation"
    | "type-alias-annotation"
    | "function-clause"
    | "header-clause";

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
    /** The text being parsed, after source projection. */
    getSourceText(): string;
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
    /** The members of a class body, up to its closing brace, which is left for the plugin. */
    parseClassMembers(): import("typescript-upstream").NodeArray<import("typescript-upstream").ClassElement>;
    /**
     * Any plugin's clause at this position, for syntax that parses a declaration itself. Call the result with the finished
     * declaration; it stays this plugin's.
     */
    parseClause(position: "function-clause" | "header-clause"): TSPPSyntaxAnnotation | undefined;
    /** Type arguments `<...>` at the current token, if it is `<` on the same line. */
    parseTypeArguments(): import("typescript-upstream").NodeArray<import("typescript-upstream").TypeNode> | undefined;
    /** In the `postfix-type` position, the type parsed so far, which the result replaces. */
    readonly precedingType?: import("typescript-upstream").TypeNode;
    parseVariableDeclarationList(inForStatementInitializer: boolean): import("typescript-upstream").VariableDeclarationList;
    finishNode<T extends import("typescript-upstream").Node>(node: T, pos: number, end?: number): T;
    /** Reports a syntax error for `start` to `end`, with the plugin's own code (18086 if it has none). */
    parseErrorAt(start: number, end: number, message: string, code?: number): void;
}

/** Syntax a plugin parses into ordinary TypeScript nodes, which the compiler then binds, checks, and emits unchanged. */
export interface TSPPSyntaxExtension {
    readonly position: TSPPSyntaxExtensionPosition;
    readonly startTokens: readonly import("typescript-upstream").SyntaxKind[];
    /**
     * The words or tokens that start this syntax. Two plugins may not claim the same one in the same position, and the
     * host refuses the second at activation. Required when `startTokens` includes identifiers, which only `isStart`
     * would tell apart otherwise.
     */
    readonly keywords?: readonly string[];
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
     * omits a statement. `node` is the declaration emitter's node, a statement or a type-level node. Nodes parsed by
     * another plugin's syntax never reach this method; of the others, at most one plugin may answer for a node.
     * `printNested` prints a node inside the declaration, such as a type the author wrote, so that any plugin's syntax
     * in it is restored too; a printer of the plugin's own would print what that syntax lowered to.
     */
    restoreDeclaration?(
        node: import("typescript-upstream").Node,
        printNested: (nested: import("typescript-upstream").Node) => string,
    ): string | undefined;
    /** The text of a node in the TypeScript-compatible `.d.ts` output that accompanies `.d.tspp` output. */
    restoreCompatibilityDeclaration?(node: import("typescript-upstream").Node): string | undefined;
    /** The text of a `function-clause` or `header-clause` in `.d.tspp` output, written where it was parsed. */
    restoreFunctionClause?(node: import("typescript-upstream").Node): string | undefined;
    /**
     * A node to bind with `node`'s children, in its scope, though it is not one of them: what a plugin recorded outside the
     * tree that still holds names and types. Editor features reach it by position.
     */
    getBoundChild?(node: import("typescript-upstream").Node): import("typescript-upstream").Node | undefined;
    /**
     * Whether a node repeats source that another node of the tree holds, keeping its positions so that an error in it is the
     * original's error, reported once. The compiler sees it as any other node; editor features only see the original.
     */
    isSourceCopy?(node: import("typescript-upstream").Node): boolean;
}

/** A type the checker hands to a type extension's instantiation, mapping type parameters to types. Opaque. */
export interface TSPPTypeMapper {
    readonly __tsppTypeMapper: never;
}

/** A diagnostic message a plugin owns: its code and its text, in which `{0}`, `{1}`, ... stand for arguments. */
export interface TSPPDiagnosticMessage {
    readonly code: number;
    readonly message: string;
}

/** Feature-independent type operations of one type checker. */
export interface TSPPTypeOperations {
    createMapper(
        sources: readonly import("typescript-upstream").TypeParameter[],
        targets: readonly import("typescript-upstream").Type[],
    ): TSPPTypeMapper;
    /** A mapper that applies `first`, when present, and then `second`. */
    combineMappers(first: TSPPTypeMapper | undefined, second: TSPPTypeMapper): TSPPTypeMapper;
    instantiate(type: import("typescript-upstream").Type, mapper: TSPPTypeMapper): import("typescript-upstream").Type;
    /** A class or interface type with its `this` type bound to `thisArgument`, by default the type itself. */
    getTypeWithThisArgument(type: import("typescript-upstream").Type, thisArgument?: import("typescript-upstream").Type): import("typescript-upstream").Type;
    /** An anonymous object type with `properties`, each instantiated with `mapper` when present. */
    createObjectType(properties: readonly import("typescript-upstream").Symbol[], mapper?: TSPPTypeMapper): import("typescript-upstream").Type;
    getIntersectionType(types: readonly import("typescript-upstream").Type[]): import("typescript-upstream").Type;
    /** Keeps the import of a value alias in JavaScript output, for a value only generated code will mention. */
    markAliasReferenced(alias: import("typescript-upstream").Symbol): void;
    /** Keeps the import of an alias in declaration output, for a name only restored declaration text will mention. */
    markAliasVisibleInDeclarations(alias: import("typescript-upstream").Symbol): void;
    /**
     * The error the checker reports at `node` when `source` is not assignable to `target`, elaborated the same way;
     * undefined when it is assignable. `headMessage` replaces the generic first line and receives the source and
     * target types as `{0}` and `{1}`; `containingMessage` comes before everything, with `containingArguments`.
     */
    getAssignabilityError(
        source: import("typescript-upstream").Type,
        target: import("typescript-upstream").Type,
        node: import("typescript-upstream").Node,
        headMessage?: TSPPDiagnosticMessage,
        containingMessage?: TSPPDiagnosticMessage,
        containingArguments?: readonly string[],
    ): import("typescript-upstream").Diagnostic | undefined;
}

/** Type operations of one type checker, for a type extension. */
export interface TSPPTypeHost extends TSPPTypeOperations {
    readonly checker: import("typescript-upstream").TypeChecker;
    /** The type the checker uses after reporting an error, which suppresses further errors. */
    readonly errorType: import("typescript-upstream").Type;
    /**
     * A new type owned by the calling extension. The checker treats it like a type parameter named by `symbol` and
     * leaves its instantiation and printing to the extension.
     */
    createType(symbol?: import("typescript-upstream").Symbol): import("typescript-upstream").Type;
    /** The type, alias resolved, that a type reference names, without reporting errors; undefined if none. */
    resolveTypeReferenceName(node: import("typescript-upstream").TypeReferenceNode | import("typescript-upstream").ExpressionWithTypeArguments): import("typescript-upstream").Symbol | undefined;
    /** The type parameters a generic type alias, class, or interface declares; undefined for other symbols. */
    getTypeParametersOfSymbol(symbol: import("typescript-upstream").Symbol): readonly import("typescript-upstream").TypeParameter[] | undefined;
    /** A generic type alias, class, or interface applied to type arguments. */
    instantiateGenericType(
        symbol: import("typescript-upstream").Symbol,
        typeArguments: readonly import("typescript-upstream").Type[],
    ): import("typescript-upstream").Type;
    /** Reports at `node` that a type argument does not satisfy its constraint, unless it does. */
    checkTypeArgumentConstraint(
        typeArgument: import("typescript-upstream").Type,
        constraint: import("typescript-upstream").Type,
        node: import("typescript-upstream").Node,
    ): boolean;
    /** Reports a semantic error at `node`, with the plugin's own code (18086 if it has none). */
    error(node: import("typescript-upstream").Node, message: string, code?: number): void;
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

/** Lets a plugin take part in how the checker treats signatures and the members of types. */
export interface TSPPSignatureConstraint {
    /**
     * Rules out an overload the checker would otherwise choose. Asked when more than one signature could apply and the
     * arguments of this one are fine. If it rules out all of them, the checker keeps the first it ruled out instead of
     * reporting a call error, and the plugin's diagnostic provider says what is wrong.
     */
    isOverloadApplicable(request: {
        /** The call being resolved. */
        readonly node: import("typescript-upstream").Node;
        readonly declaration: import("typescript-upstream").SignatureDeclaration | import("typescript-upstream").JSDocSignature;
        readonly checker: import("typescript-upstream").TypeChecker;
        /** A type written in terms of the signature's type parameters, with the type arguments of this call. */
        instantiate(type: import("typescript-upstream").Type): import("typescript-upstream").Type;
    }): boolean;
    /** Why a function with signature `source` cannot be used as one with signature `target`, or undefined if it can. */
    whyNotRelated(request: {
        readonly source: import("typescript-upstream").SignatureDeclaration | import("typescript-upstream").JSDocSignature | undefined;
        readonly target: import("typescript-upstream").SignatureDeclaration | import("typescript-upstream").JSDocSignature | undefined;
        readonly checker: import("typescript-upstream").TypeChecker;
        /** A type written in terms of a signature's type parameters, as this comparison instantiates that signature. */
        instantiateSource(type: import("typescript-upstream").Type): import("typescript-upstream").Type;
        instantiateTarget(type: import("typescript-upstream").Type): import("typescript-upstream").Type;
    }): { readonly code: number; readonly message: string; } | undefined;
    /** A property a value has though its type does not list it; asked only when the type has no such property. */
    getMember?(request: {
        readonly node: import("typescript-upstream").Node;
        readonly leftType: import("typescript-upstream").Type;
        readonly apparentType: import("typescript-upstream").Type;
        readonly name: string;
        readonly checker: import("typescript-upstream").TypeChecker;
        readonly types: TSPPTypeOperations;
    }): import("typescript-upstream").Symbol | undefined;
    /** Every property `getMember` could add to `type`, for completions. */
    getMembers?(request: {
        readonly type: import("typescript-upstream").Type;
        readonly checker: import("typescript-upstream").TypeChecker;
        readonly types: TSPPTypeOperations;
    }): readonly import("typescript-upstream").Symbol[];
}

/** Semantic diagnostics a plugin adds to each source file; comment directives such as `@ts-expect-error` apply. */
export interface TSPPDiagnosticProvider {
    readonly id: string;
    getSemanticDiagnostics(
        sourceFile: import("typescript-upstream").SourceFile,
        checker: import("typescript-upstream").TypeChecker,
        types: TSPPTypeOperations,
    ): readonly import("typescript-upstream").Diagnostic[];
    /**
     * Return false to drop a diagnostic the checker reported, for example one about code this plugin generated, or a
     * diagnostic to report in its place, for example at the source text a generated node stands for. Only called for
     * diagnostics inside syntax this plugin parsed, innermost plugin first.
     */
    filterDiagnostic?(diagnostic: import("typescript-upstream").Diagnostic): boolean | import("typescript-upstream").Diagnostic;
}

/**
 * Binds interface members outside the instance type, on the interface's static side: they are allowed there, and
 * resolve names the way static class members do. What implementations owe for them is the registering plugin's to
 * check, for example with a diagnostic provider.
 */
export interface TSPPInterfaceMemberBinding {
    /** The words that mark such a member, which two plugins may not share. */
    readonly keywords: readonly string[];
    isStaticMember(member: import("typescript-upstream").Node): boolean;
}

export interface TSPPCompilerPluginAPI {
    registerInterfaceMemberBinding(binding: TSPPInterfaceMemberBinding): TSPPPluginDisposer;
    registerProgramAnalyzer(analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerProgramRebuilder(rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
    registerSyntaxExtension(extension: TSPPSyntaxExtension): TSPPPluginDisposer;
    registerDiagnosticProvider(provider: TSPPDiagnosticProvider): TSPPPluginDisposer;
    registerTypeExtension(extension: TSPPTypeExtension): TSPPPluginDisposer;
    registerSignatureConstraint(constraint: TSPPSignatureConstraint): TSPPPluginDisposer;
    /**
     * The words active plugins claim at a syntax position, such as the keywords that declare a name at `declaration`.
     * Read them while working, since plugins may activate later. A plugin that must tell authored syntax apart uses this
     * instead of naming another plugin's keywords.
     */
    getSyntaxKeywords(position: TSPPSyntaxPosition): readonly string[];
    /** The text a source file's author wrote, before any plugin projected it. Positions in the parsed file apply to it. */
    getAuthoredText(sourceFile: import("typescript-upstream").SourceFile): string;
}

export interface TSPPCompilerHostAPI {
    registerInterfaceMemberBinding(pluginId: string, binding: TSPPInterfaceMemberBinding): TSPPPluginDisposer;
    registerProgramAnalyzer(pluginId: string, analyzer: TSPPProgramAnalyzer): TSPPPluginDisposer;
    registerSourcePreprocessor(pluginId: string, preprocessor: TSPPSourcePreprocessor): TSPPPluginDisposer;
    registerProgramRebuilder(pluginId: string, rebuilder: TSPPProgramRebuilder): TSPPPluginDisposer;
    registerSyntaxExtension(pluginId: string, extension: TSPPSyntaxExtension): TSPPPluginDisposer;
    registerDiagnosticProvider(pluginId: string, provider: TSPPDiagnosticProvider): TSPPPluginDisposer;
    registerTypeExtension(pluginId: string, extension: TSPPTypeExtension): TSPPPluginDisposer;
    registerSignatureConstraint(pluginId: string, constraint: TSPPSignatureConstraint): TSPPPluginDisposer;
    getSyntaxKeywords(position: TSPPSyntaxPosition): readonly string[];
    /** The text a source file's author wrote, before any plugin projected it. Positions in the parsed file apply to it. */
    getAuthoredText(sourceFile: import("typescript-upstream").SourceFile): string;
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
