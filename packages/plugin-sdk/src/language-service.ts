import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

export interface TSPPQuickInfoRequest {
    readonly fileName: string;
    readonly sourceText: string;
    readonly position: number;
    /**
     * Whether the position is inside syntax this plugin parsed or projected. Providers are asked innermost owner first,
     * then the rest in plugin id order, so answer for a keyword of your own syntax only when this is true.
     */
    readonly owned: boolean;
    /** Source-level word under the cursor, when one exists. */
    readonly token?: TSPPQuickInfoToken;
    /** Best semantic type available before feature-specific formatting. */
    readonly semanticType?: string;
    /** Quick info produced by the underlying TypeScript language service. */
    readonly upstream?: TSPPQuickInfoBase;
}

export interface TSPPQuickInfoToken {
    readonly start: number;
    readonly length: number;
    readonly text: string;
}

export interface TSPPQuickInfoBase {
    readonly display: string;
    readonly kind: string;
}

export interface TSPPQuickInfo {
    readonly start: number;
    readonly length: number;
    readonly display: string;
    readonly documentation?: string;
}

export type TSPPQuickInfoProvider = (request: TSPPQuickInfoRequest) => TSPPQuickInfo | undefined;

/** The semantic token classes an editor colours, as TypeScript's language service reports them. */
export const tsppSemanticTokenTypes = ["class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable", "enumMember", "property", "function", "member"] as const;

export type TSPPSemanticTokenType = (typeof tsppSemanticTokenTypes)[number];

export interface TSPPSemanticToken {
    readonly start: number;
    readonly length: number;
    readonly type: TSPPSemanticTokenType;
}

/** A name a file imports, with the source of the file that declares it. */
export interface TSPPSemanticTokenImport {
    readonly name: string;
    readonly importedName: string;
    readonly sourceText: string;
}

export interface TSPPSemanticTokensRequest {
    readonly fileName: string;
    readonly sourceText: string;
    /** What the language service classified; plugin syntax it never saw has no tokens here. */
    readonly tokens: readonly TSPPSemanticToken[];
    readonly imports: readonly TSPPSemanticTokenImport[];
    /** Whether the range is inside syntax this plugin parsed or projected, as `owned` says of Quick Info. */
    isOwned(start: number, end: number): boolean;
}

const typeScriptKeywords = new Set(["abstract", "any", "as", "asserts", "async", "await", "bigint", "boolean", "break", "case", "catch", "class", "const", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally", "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof", "interface", "is", "keyof", "let", "module", "namespace", "never", "new", "null", "number", "object", "of", "package", "private", "protected", "public", "readonly", "return", "satisfies", "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true", "try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "with", "yield"]);

export function isTypeScriptKeyword(word: string): boolean {
    return typeScriptKeywords.has(word);
}

export interface TSPPCodeToken {
    readonly kind: "name" | "open" | "close";
    readonly start: number;
    readonly text: string;
}

/** The names and brackets of source text, outside its comments and strings, for providers of syntax the tree lowered away. */
export function* scanTSPPCode(sourceText: string): Generator<TSPPCodeToken> {
    for (const match of sourceText.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`|\d[\w.]*|[A-Za-z_$][\w$]*|[({[\])}]/g)) {
        const text = match[0];
        if (/^[A-Za-z_$]/.test(text)) yield { kind: "name", start: match.index, text };
        else if (/^[({[]$/.test(text)) yield { kind: "open", start: match.index, text };
        else if (/^[)}\]]$/.test(text)) yield { kind: "close", start: match.index, text };
    }
}

/** A keyword of plugin syntax, which lowering may have turned into a name that got a token of its own. */
export interface TSPPClearedSemanticToken {
    readonly start: number;
    readonly length: number;
    readonly type: "none";
}

/** The tokens of a file that plugin syntax decides. Each replaces a token at its start; the host keeps them in order. */
export type TSPPSemanticTokensProvider = (request: TSPPSemanticTokensRequest) => readonly (TSPPSemanticToken | TSPPClearedSemanticToken)[];

export interface TSPPLanguageServiceHostAPI {
    registerQuickInfoProvider(pluginId: string, provider: TSPPQuickInfoProvider): TSPPPluginDisposer;
    registerSemanticTokensProvider(pluginId: string, provider: TSPPSemanticTokensProvider): TSPPPluginDisposer;
}

export interface TSPPLanguageServicePluginAPI {
    registerQuickInfoProvider(provider: TSPPQuickInfoProvider): TSPPPluginDisposer;
    registerSemanticTokensProvider(provider: TSPPSemanticTokensProvider): TSPPPluginDisposer;
}

/** Feature-owned semantic tooling that is transported through tsserver and LSP. */
export interface TSPPLanguageServicePluginContext {
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;
    readonly languageService: TSPPLanguageServicePluginAPI;
    onDispose(disposer: TSPPPluginDisposer): void;
}

export interface TSPPLanguageServicePlugin {
    activate(context: TSPPLanguageServicePluginContext): void | TSPPPluginDisposer;
}
