import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import { formatTSPPSyntax, layoutTSPPCode } from "@tspp/plugin-sdk/language-service";

import { createModernSyntax } from "./desugar";

const pluginId = "modern-syntax";

/** Whether text starts, past spaces and comments, with a `use` binding. */
const startsWithUse = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*use(?![\w$])/;

export const modernSyntaxPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Modern syntax",
        syntax: {
            keywords: [
                { keyword: "let", position: "expression" },
                { keyword: "do", position: "expression" },
                { keyword: "do", position: "function-body" },
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
                context.onDispose(context.languageService.registerFormattingProvider(request => [
                    ...layoutTSPPCode(request, request.unformattedRanges(), { decisive: true, continuationWords: ["in"] }),
                    // A `use` takes the rest of its block as its continuation, which the formatter does not lay out.
                    ...layoutTSPPCode(request, request.ownedRanges().filter(range => startsWithUse.test(request.sourceText.slice(range.start, range.end))), { decisive: true, continuationWords: ["in"] }),
                    ...formatTSPPSyntax(request),
                ]));
                return context.languageService.registerQuickInfoProvider(request => {
                    const token = request.token;
                    if (!token) return undefined;
                    const keyword = request.owned && modernKeywords.find(entry => entry.text === token.text);
                    if (keyword) {
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(TS++ keyword) ${token.text}`,
                            documentation: keyword.documentation,
                        };
                    }
                    const defNames = defBindingNames(request.sourceText);
                    if (defNames.has(token.text)) {
                        const upstream = request.upstream?.display;
                        if (upstream && /(?:^|\b)const\s+/.test(upstream)) {
                            return {
                                start: token.start,
                                length: token.length,
                                display: upstream.replace(/^(?:\(alias\)\s+)?(?:\(const\)|const)\b/, match => match.replace("const", "def")),
                            };
                        }
                        if (request.owned && /\bdef\s+$/.test(request.sourceText.slice(0, token.start))) {
                            return {
                                start: token.start,
                                length: token.length,
                                display: `def ${token.text}`,
                            };
                        }
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

const modernKeywords = [
    { text: "let", documentation: "Introduces a lexical binding inside an expression." },
    { text: "in", documentation: "Separates expression-local bindings from their result expression." },
    { text: "do", documentation: "Starts a completion-valued block whose final expression is returned." },
    { text: "use", documentation: "Binds the value supplied to a trailing continuation." },
    { text: "def", documentation: "Declares a deeply readonly binding with const-context inference." },
] as const;

function defBindingNames(sourceText: string): Set<string> {
    const names = new Set<string>();
    const stripped = sourceText.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/g, " ");
    const defRegex = /\bdef\s+/g;
    let defMatch: RegExpExecArray | null;
    while ((defMatch = defRegex.exec(stripped)) !== null) {
        let index = defMatch.index + defMatch[0].length;
        while (index < stripped.length) {
            while (index < stripped.length && /\s/.test(stripped[index])) index++;
            const identMatch = /^[A-Za-z_$][\w$]*/.exec(stripped.slice(index));
            if (identMatch) {
                names.add(identMatch[0]);
                index += identMatch[0].length;
            } else if (stripped[index] === "{" || stripped[index] === "[") {
                let bDepth = 0;
                while (index < stripped.length) {
                    if (stripped[index] === "{" || stripped[index] === "[") bDepth++;
                    else if (stripped[index] === "}" || stripped[index] === "]") {
                        bDepth--;
                        if (bDepth === 0) { index++; break; }
                    } else if (/[A-Za-z_$]/.test(stripped[index])) {
                        const m = /^[A-Za-z_$][\w$]*/.exec(stripped.slice(index));
                        if (m) {
                            names.add(m[0]);
                            index += m[0].length;
                            continue;
                        }
                    }
                    index++;
                }
            } else {
                break;
            }
            let depth = 0;
            let endOfDef = false;
            while (index < stripped.length) {
                const ch = stripped[index];
                if (ch === "{" || ch === "(" || ch === "[") depth++;
                else if (ch === "}" || ch === ")" || ch === "]") { if (depth > 0) depth--; }
                else if (depth === 0) {
                    if (ch === ";") { endOfDef = true; break; }
                    if (ch === ",") { index++; break; }
                }
                index++;
            }
            if (endOfDef) break;
        }
    }
    return names;
}

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
