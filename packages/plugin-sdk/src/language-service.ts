import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";
import { maskNonCode, nonCodeRanges } from "./text";

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
    // Names are ECMAScript identifiers, which may be written in any script.
    for (const match of sourceText.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`|\d[\w.]*|[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*|[({[\])}]/gu)) {
        const text = match[0];
        if (/^[\p{ID_Start}_$]/u.test(text)) yield { kind: "name", start: match.index, text };
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

/** How the editor asked for code to be laid out, as TypeScript's formatter reads it. */
export interface TSPPFormattingOptions {
    readonly indentSize: number;
    readonly tabSize: number;
    readonly convertTabsToSpaces: boolean;
    readonly newLineCharacter: string;
}

export interface TSPPFormattingRequest {
    readonly fileName: string;
    /** The authored text, which the edits apply to. */
    readonly sourceText: string;
    /** The range the editor asked to format: the whole file, a selection, or the lines around a keystroke. */
    readonly start: number;
    readonly end: number;
    readonly options: TSPPFormattingOptions;
    /** The key typed, when the editor formats on typing. */
    readonly key?: string;
    /**
     * Whether the range is inside syntax this plugin parsed or projected, as `owned` says of Quick Info, or inside a node
     * TypeScript's formatter leaves as written because this plugin's syntax is in it.
     */
    isOwned(start: number, end: number): boolean;
    /** The ranges `isOwned` accepts, sorted and merged. */
    ownedRanges(): readonly { readonly start: number; readonly end: number; }[];
    /**
     * The part of `ownedRanges` TypeScript's formatter does not lay out at all: text the plugin projected, and nodes it
     * leaves as written. An edit here takes the place of any formatter edit it overlaps; elsewhere it gives way to it.
     */
    unformattedRanges(): readonly { readonly start: number; readonly end: number; }[];
    /** The indentation, in columns, of the line holding `position` once TypeScript's formatter has laid it out. */
    indentationAt(position: number): number;
}

/** Replaces `length` characters at `start` with `newText`, positions being those of the authored text. */
export interface TSPPTextEdit {
    readonly start: number;
    readonly length: number;
    readonly newText: string;
}

/**
 * Lays out the plugin's own syntax. The host keeps an edit only when it is inside the requested range and the plugin's
 * syntax, changes nothing but whitespace (and semicolons) outside comments and literals, and overlaps no edit kept
 * before it; inside `unformattedRanges`, or when it is `decisive`, it takes the place of any edit of TypeScript's
 * formatter it overlaps, and elsewhere it gives way to one. Providers are asked in plugin id order. `formatTSPPSyntax` is a provider that fits most
 * syntax.
 */
export type TSPPFormattingProvider = (request: TSPPFormattingRequest) => readonly TSPPFormattingEdit[];

/** An edit of a formatting provider. */
export interface TSPPFormattingEdit extends TSPPTextEdit {
    /**
     * Whether the edit takes the place of a formatter edit it overlaps even outside `unformattedRanges`, for syntax whose
     * lowered tree the formatter lays out wrongly. An edit that changes nothing still makes the formatter's give way.
     */
    readonly decisive?: boolean;
}

export interface TSPPLanguageServiceHostAPI {
    registerQuickInfoProvider(pluginId: string, provider: TSPPQuickInfoProvider): TSPPPluginDisposer;
    registerSemanticTokensProvider(pluginId: string, provider: TSPPSemanticTokensProvider): TSPPPluginDisposer;
    registerFormattingProvider(pluginId: string, provider: TSPPFormattingProvider): TSPPPluginDisposer;
}

export interface TSPPLanguageServicePluginAPI {
    registerQuickInfoProvider(provider: TSPPQuickInfoProvider): TSPPPluginDisposer;
    registerSemanticTokensProvider(provider: TSPPSemanticTokensProvider): TSPPPluginDisposer;
    registerFormattingProvider(provider: TSPPFormattingProvider): TSPPPluginDisposer;
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

/** Characters after which a space inside a construct goes, and before which it goes. */
const tightAfter = new Set(["(", "["]);
const tightBefore = new Set([")", "]", ",", ";"]);
/** A line starting with one of these continues the expression of the line before it. */
const continuationStarts = /^(?:[?:.|&+*%]|-(?!-)|\/(?![/*])|=>|>>?(?![=>]))/;
/** A line ending with one of these continues on the next one. */
const continuationEnds = /(?:[=+*%|&?]|=>|-(?!-)|<-)$/;

export interface TSPPLayoutOptions {
    /** Whether to change the spaces between code on a line: runs collapse to one, and go after `(` `[` and before `)` `]` `,` `;`. Defaults to true. */
    readonly spaces?: boolean;
    /** Whether to indent the lines after a range's first. Defaults to true. */
    readonly indentation?: boolean;
    /** Words of the plugin's syntax that continue an expression, as an operator would, when a line starts or ends with them. */
    readonly continuationWords?: readonly string[];
    /**
     * Whether these edits decide the layout of what they cover even where TypeScript's formatter has an opinion, for
     * syntax whose lowered tree it lays out wrongly. Lines and spaces already laid out get edits that change nothing, so
     * that the formatter's edits there give way too.
     */
    readonly decisive?: boolean;
}

/**
 * The edits that lay out `ranges` of a formatting request the way TypeScript's formatter lays out code, for providers of
 * syntax it does not see. Each range's first line has the indentation `indentationAt` gives it, which it gets when the
 * range starts the line. A later line inside
 * brackets is indented one level more than the line that opened the innermost of them, and a line starting with closing
 * brackets as much as that line; a line that continues an expression, after or before an operator or one of
 * `continuationWords`, one level more than the line before; any other line as much as the range's first. Runs of spaces
 * between code collapse to one space, or none next to brackets and separators. Text in comments and literals, blank
 * lines, and line breaks stay as they are; trailing spaces go.
 */
export function layoutTSPPCode(request: TSPPFormattingRequest, ranges: readonly { readonly start: number; readonly end: number; }[], layout: TSPPLayoutOptions = {}): TSPPFormattingEdit[] {
    const { sourceText: text, options } = request;
    // Spaces and tabs of code read as no-break spaces in the mask, so a blank there is a comment or a literal.
    const mask = maskNonCode(text.replace(/[ \t]/g, " "));
    const isCodeSpace = (index: number) => mask[index] === " ";
    const isCode = (index: number) => index >= 0 && index < text.length && mask[index] !== " " && mask[index] !== " " && mask[index] !== "\n" && mask[index] !== "\r";
    const startsComment = (index: number) => text.startsWith("//", index) || text.startsWith("/*", index);
    /** Positions inside a comment or a literal, past its first character, where a line continues it. */
    let inside: Uint8Array | undefined;
    const isInsideNonCode = (index: number) => {
        if (!inside) {
            inside = new Uint8Array(text.length + 1);
            for (const range of nonCodeRanges(text)) inside.fill(1, range.start + 1, range.end);
        }
        return inside[index] === 1;
    };
    const words = (layout.continuationWords ?? []).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const startsWithWord = words ? new RegExp(`^(?:${words})(?![\\w$])`) : undefined;
    const endsWithWord = words ? new RegExp(`(?<![\\w$.])(?:${words})$`) : undefined;
    const indentText = (columns: number) => options.convertTabsToSpaces ? " ".repeat(columns) : "\t".repeat(Math.floor(columns / options.tabSize)) + " ".repeat(columns % options.tabSize);
    const columnsOf = (indentation: string) => [...indentation].reduce((columns, character) => character === "\t" ? columns + options.tabSize - columns % options.tabSize : columns + 1, 0);
    const edits: TSPPFormattingEdit[] = [];
    const push = (start: number, end: number, newText: string) => {
        if (start < request.start || end > request.end) return;
        if (text.slice(start, end) !== newText) edits.push({ start, length: end - start, newText, decisive: layout.decisive });
        else if (layout.decisive) edits.push({ start, length: end - start, newText, decisive: true });
    };
    /** The code of a line without its comment, trimmed, with `x` for each character of a literal. */
    const codeOf = (lineStart: number) => {
        const lineEnd = text.indexOf("\n", lineStart) < 0 ? text.length : text.indexOf("\n", lineStart);
        let code = "";
        for (let index = lineStart; index < lineEnd; index++) code += isCode(index) ? text[index] : isCodeSpace(index) ? " " : startsComment(index) && !isInsideNonCode(index) ? "\u0000" : "x";
        return code.split("\u0000")[0].trim();
    };
    if (layout.indentation !== false) {
        for (const range of ranges) {
            const start = Math.max(range.start, 0);
            const end = Math.min(range.end, text.length);
            const firstLineStart = text.lastIndexOf("\n", start - 1) + 1;
            const base = request.indentationAt(start);
            /** For each open bracket, the indentation of the line that opened it. */
            const open: number[] = [];
            let lineIndent = base;
            let previous: { code: string; indent: number; continued: boolean; } | undefined;
            for (let lineStart = firstLineStart; lineStart < end;) {
                const lineEnd = text.indexOf("\n", lineStart) < 0 ? text.length : text.indexOf("\n", lineStart);
                let indentEnd = lineStart;
                while (text[indentEnd] === " " || text[indentEnd] === "\t") indentEnd++;
                const blank = indentEnd >= lineEnd || text[indentEnd] === "\r";
                const inLiteral = isInsideNonCode(lineStart);
                const code = codeOf(lineStart);
                if (lineStart > firstLineStart) {
                    if (blank) {
                        if (indentEnd > lineStart && !inLiteral) push(lineStart, indentEnd, "");
                    }
                    else if (!inLiteral) {
                        const closers = /^(?:[)\]}]|>(?![>=]))*/.exec(code)![0].length;
                        const startsContinuation = !!code && (continuationStarts.test(code) || !!startsWithWord?.test(code));
                        const previousEnds = !!previous && (continuationEnds.test(previous.code) || !!endsWithWord?.test(previous.code)) && !/[{([,;]$/.test(previous.code);
                        let indent: number;
                        let continued = false;
                        if (closers && open.length) indent = open[Math.max(open.length - closers, 0)];
                        else if (previous && startsContinuation) {
                            indent = previous.continued && (continuationStarts.test(previous.code) || !!startsWithWord?.test(previous.code)) ? previous.indent : previous.indent + options.indentSize;
                            continued = true;
                        }
                        else if (previous && previousEnds) {
                            indent = previous.indent + options.indentSize;
                            continued = true;
                        }
                        else indent = open.length ? open[open.length - 1] + options.indentSize : base;
                        push(lineStart, indentEnd, indentText(indent));
                        lineIndent = indent;
                        if (code) previous = { code, indent, continued };
                    }
                    else {
                        // A line inside a comment or literal keeps its indentation, and is the line before the next one.
                        lineIndent = columnsOf(text.slice(lineStart, indentEnd));
                        if (code) previous = { code, indent: lineIndent, continued: false };
                    }
                }
                else {
                    // A range that starts its line lays that line out too.
                    if (!blank && !inLiteral && indentEnd >= start) push(lineStart, indentEnd, indentText(base));
                    lineIndent = base;
                    if (code) previous = { code, indent: base, continued: false };
                }
                // Brackets of the line, in order; a `<` that ends the line opens like a bracket, and a `>` starting one closes it.
                for (let index = lineStart; index < lineEnd; index++) {
                    if (!isCode(index)) continue;
                    const character = text[index];
                    // Every bracket remembers its line's indentation, so brackets opened on one line indent what follows once.
                    if (character === "(" || character === "[" || character === "{") open.push(lineIndent);
                    else if ((character === ")" || character === "]" || character === "}") && open.length) open.pop();
                    else if (character === ">" && index === indentEnd && text[index + 1] !== "=" && text[index + 1] !== ">" && open.length) open.pop();
                }
                if (code.endsWith("<")) open.push(lineIndent);
                lineStart = lineEnd + 1;
            }
        }
    }
    if (layout.spaces !== false) {
        for (const range of ranges) {
            // One character either side, so that a range that begins or ends with spaces sees what they separate.
            const from = Math.max(range.start - 1, 0);
            for (const match of text.slice(from, Math.min(range.end + 1, text.length)).matchAll(/(?<=\S)[ \t]+(?=\S)|[ \t]+(?=\r?\n)/g)) {
                const runStart = from + match.index;
                const runEnd = runStart + match[0].length;
                if (![...match[0]].every((_, offset) => isCodeSpace(runStart + offset))) continue;
                if (text[runEnd] === "\n" || text[runEnd] === "\r") {
                    // Trailing spaces go, except on a line of nothing else, which indentation decides.
                    if (text.lastIndexOf("\n", runStart - 1) + 1 !== runStart) push(runStart, runEnd, "");
                    continue;
                }
                if (startsComment(runEnd)) continue;
                const tight = tightAfter.has(text[runStart - 1]) || tightBefore.has(text[runEnd]);
                push(runStart, runEnd, tight ? "" : " ");
            }
        }
    }
    return edits;
}

/**
 * A formatting provider for most plugin syntax: what the formatter does not lay out at all is laid out by
 * `layoutTSPPCode`, and the spaces of the rest of the plugin's syntax are tidied where the formatter leaves them.
 */
export const formatTSPPSyntax: TSPPFormattingProvider = request => [
    ...layoutTSPPCode(request, request.unformattedRanges(), { decisive: true }),
    ...layoutTSPPCode(request, request.ownedRanges(), { indentation: false }),
];
