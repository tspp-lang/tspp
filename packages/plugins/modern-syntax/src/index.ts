import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { createModernSyntax } from "./desugar";

const pluginId = "modern-syntax";

export const modernSyntaxPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Modern syntax",
        syntax: {
            keywords: [
                { keyword: "let", position: "expression" },
                { keyword: "do", position: "expression" },
                { keyword: "do", position: "function-clause" },
                { keyword: "use", position: "statement" },
                { keyword: "def", position: "statement" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const { extensions, diagnostics } = createModernSyntax(context.ts);
                for (const extension of extensions) context.onDispose(context.compiler.registerSyntaxExtension(extension));
                return context.compiler.registerDiagnosticProvider(diagnostics);
            },
        },
        languageService: {
            activate(context) {
                return context.languageService.registerQuickInfoProvider(request => {
                    const token = request.token;
                    if (!token) return undefined;
                    if (["let", "in", "do", "use", "def"].includes(token.text)) {
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(TS++ keyword) ${token.text}`,
                            documentation: modernKeywordDocumentation[token.text],
                        };
                    }
                    const statement = trailingClosureStatementAt(request.sourceText, token.start);
                    if (!statement) return undefined;
                    const match = /\buse\s+([A-Za-z_$][\w$]*)\s*(?::\s*([^<;]+?))?\s*<-\s*([A-Za-z_$][\w$]*)/.exec(statement);
                    if (!match) return undefined;
                    const [, binding, annotation, callee] = match;
                    if (token.text === binding) {
                        const inferred = annotation?.trim()
                            ?? usefulType(request.semanticType)
                            ?? inferContinuationParameter(request.sourceText, callee);
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(const) ${binding}: ${inferred ?? "unknown"}`,
                            documentation: "A value supplied by the trailing continuation parameter.",
                        };
                    }
                    if (token.text === callee && !usefulDisplay(request.upstream?.display)) {
                        const declaration = functionDeclaration(request.sourceText, callee);
                        if (declaration) {
                            return { start: token.start, length: token.length, display: declaration };
                        }
                    }
                    return undefined;
                });
            },
        },
        editor: {
            keywords: ["in"],
            grammars: ["./editor/modern-syntax.tmLanguage.json"],
        },
    },
});

export default modernSyntaxPlugin;

const modernKeywordDocumentation: Readonly<Record<string, string>> = {
    let: "Introduces a lexical binding inside an expression.",
    in: "Separates expression-local bindings from their result expression.",
    do: "Starts a completion-valued block whose final expression is returned.",
    use: "Binds the value supplied to a trailing continuation.",
    def: "Declares a deeply readonly binding with const-context inference.",
};

function trailingClosureStatementAt(sourceText: string, position: number): string | undefined {
    const start = Math.max(sourceText.lastIndexOf(";", position - 1), sourceText.lastIndexOf("{", position - 1)) + 1;
    const end = sourceText.indexOf(";", position);
    if (end < 0) return undefined;
    const statement = sourceText.slice(start, end + 1);
    return /\buse\b/.test(statement) ? statement : undefined;
}

function usefulType(type: string | undefined): string | undefined {
    return type && type !== "any" && type !== "unknown" ? type : undefined;
}

function usefulDisplay(display: string | undefined): boolean {
    return !!display && !/\bany\b|\(Missing\)/.test(display);
}

/** The type of the first parameter of the callee's last (continuation) parameter, read from its signature text. */
function inferContinuationParameter(sourceText: string, functionName: string): string | undefined {
    const declaration = functionDeclarationSource(sourceText, functionName);
    let open = -1;
    if (declaration) scanDepth(declaration, (character, index, depth) => {
        if (character === "(" && depth === 0) { open = index; return true; }
    });
    const parameters = declaration && parenthesizedContents(declaration, open);
    if (parameters === undefined) return undefined;
    const continuation = annotationOf(splitTopLevel(parameters, ",").pop() ?? "");
    if (!continuation?.startsWith("(")) return undefined;
    const continuationParameters = parenthesizedContents(continuation, 0);
    return continuationParameters === undefined ? undefined : annotationOf(splitTopLevel(continuationParameters, ",")[0] ?? "");
}

const openers = "([{<";
const closers = ")]}>";

/** Visits each character with the bracket depth before it; `=>` never counts as a closing `>`. */
function scanDepth(text: string, visit: (character: string, index: number, depth: number) => boolean | void): void {
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === ">" && text[index - 1] === "=") continue;
        if (closers.includes(character)) depth--;
        if (visit(character, index, depth)) return;
        if (openers.includes(character)) depth++;
    }
}

function parenthesizedContents(text: string, open: number): string | undefined {
    if (text[open] !== "(") return undefined;
    let close = -1;
    scanDepth(text.slice(open), (character, index, depth) => {
        if (character === ")" && depth === 0) { close = open + index; return true; }
    });
    return close < 0 ? undefined : text.slice(open + 1, close);
}

function splitTopLevel(text: string, separator: string): string[] {
    const parts: string[] = [];
    let start = 0;
    scanDepth(text, (character, index, depth) => {
        if (character === separator && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
    });
    const last = text.slice(start);
    return last.trim() ? [...parts, last] : parts;
}

/** The type annotation of one `name: Type` parameter, if it has one. */
function annotationOf(parameter: string): string | undefined {
    let colon = -1;
    scanDepth(parameter, (character, index, depth) => {
        if (character === ":" && depth === 0) { colon = index; return true; }
    });
    return colon < 0 ? undefined : parameter.slice(colon + 1).trim() || undefined;
}

function functionDeclaration(sourceText: string, functionName: string): string | undefined {
    const declaration = functionDeclarationSource(sourceText, functionName);
    return declaration && `(function) ${declaration.replace(/\s+/g, " ").trim()}`;
}

function functionDeclarationSource(sourceText: string, functionName: string): string | undefined {
    const escaped = functionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`\\bfunction\\s+${escaped}\\b`).exec(sourceText);
    if (!match) return undefined;
    // The signature ends at the body or, for an ambient declaration, at its semicolon.
    let end = -1;
    scanDepth(sourceText.slice(match.index), (character, index, depth) => {
        if (depth === 0 && (character === "{" || character === ";")) { end = match.index + index; return true; }
    });
    return end < 0 ? undefined : sourceText.slice(match.index, end).trim();
}
