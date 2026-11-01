import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type { TSPPTypeMatchArm, TSPPTypeSyntax } from "@tspp/plugin-sdk/compiler";

const pluginId = "type-computation";

export const typeComputationPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Type computation",
        syntax: {
            keywords: [
                { keyword: "let", position: "type" },
                { keyword: "match", position: "type" },
                { keyword: "<", position: "type" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const kinds = context.compiler.typeSyntaxKinds;
                const syntax: TSPPTypeSyntax = {
                    startTokens: [kinds.letKeyword, kinds.identifier, kinds.lessThanToken],
                    preserveDeclarationText: true,
                    isStart: parser => {
                        if (parser.token() === kinds.letKeyword) {
                            return parser.lookAhead(() => {
                                parser.nextToken();
                                if (parser.token() !== kinds.identifier) return false;
                                parser.nextToken();
                                return parser.token() === kinds.equalsToken;
                            });
                        }
                        if (parser.token() === kinds.identifier) {
                            if (parser.tokenText() !== "match") return false;
                            return parser.lookAhead(() => {
                                parser.nextToken();
                                if (parser.hasPrecedingLineBreak()) return false;
                                parser.parseType();
                                return parser.token() === kinds.openBraceToken;
                            });
                        }
                        return parser.lookAhead(() => {
                            const parameters = parser.parseTypeParameters();
                            if (!parameters || parser.token() !== kinds.equalsGreaterThanToken) return false;
                            parser.nextToken();
                            return parser.token() === kinds.greaterThanToken;
                        });
                    },
                    parse: parser => {
                        const pos = parser.getNodePos();
                        if (parser.token() === kinds.letKeyword) {
                            parser.nextToken();
                            const name = parser.parseIdentifier();
                            parser.parseExpected(kinds.equalsToken);
                            const value = parser.parseType();
                            parser.parseExpected(kinds.inKeyword);
                            return parser.finishScopedTypeBinding(name, value, parser.parseType(), pos);
                        }
                        if (parser.token() === kinds.identifier) {
                            parser.nextToken();
                            const scrutinee = parser.parseType();
                            parser.parseExpected(kinds.openBraceToken);
                            const arms: TSPPTypeMatchArm[] = [];
                            while (
                                parser.token() !== kinds.closeBraceToken
                                && parser.token() !== kinds.endOfFileToken
                            ) {
                                const pattern = parser.parseTypeMatchPattern();
                                parser.parseExpected(kinds.colonToken);
                                arms.push({ pattern, result: parser.parseType() });
                                if (parser.token() === kinds.commaToken || parser.token() === kinds.semicolonToken) {
                                    parser.nextToken();
                                }
                                else break;
                            }
                            parser.parseExpected(kinds.closeBraceToken);
                            return parser.finishOrderedTypeMatch(scrutinee, arms, pos);
                        }
                        const parameters = parser.parseTypeParameters();
                        if (!parameters) throw new Error("Type constructor parameters were not parsed.");
                        parser.parseExpected(kinds.equalsGreaterThanToken);
                        parser.parseExpected(kinds.greaterThanToken);
                        return parser.finishTypeConstructor(parameters, parser.parseType(), pos);
                    },
                };
                return context.compiler.registerTypeSyntax(syntax);
            },
        },
        languageService: {
            activate(context) {
                return context.languageService.registerQuickInfoProvider(request => {
                    const token = request.token;
                    if (!token) return undefined;
                    if (["let", "in", "match", "infer"].includes(token.text)) {
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(TS++ keyword) ${token.text}`,
                            documentation: typeComputationKeywordDocumentation[token.text],
                        };
                    }

                    const lambda = typeLambdaAt(request.sourceText, token.start);
                    if (lambda?.name === token.text) return quickInfo(token, `type ${lambda.declaration}`);
                    if (lambda?.parameters.includes(token.text)) {
                        return quickInfo(token, `(type parameter) ${token.text} in ${lambda.constructor}`);
                    }

                    const local = scopedTypeBinding(request.sourceText, token.text);
                    if (local) return quickInfo(token, `type ${token.text} = ${local}`);
                    if (isInferBinding(request.sourceText, token.start, token.text)) {
                        return quickInfo(token, `(type parameter) ${token.text}`);
                    }

                    // `F: Type => Type` in a type parameter list is a kinded parameter, not a property.
                    const declaringOwner = typeParameterListOwnerAt(request.sourceText, token.start);
                    if (declaringOwner) return quickInfo(token, `(type parameter) ${token.text} in ${declaringOwner}`);

                    const propertyType = propertyTypeAt(request.sourceText, token.start, token.text);
                    if (propertyType) return quickInfo(token, `(property) ${token.text}: ${propertyType}`);

                    const owner = enclosingTypeParameterOwner(request.sourceText, token.start, token.text);
                    if (owner && !usefulDisplay(request.upstream?.display)) {
                        return quickInfo(token, `(type parameter) ${token.text} in ${owner}`);
                    }
                    return undefined;
                });
            },
        },
        editor: {
            keywords: ["let", "in", "match", "infer"],
            grammars: ["./editor/type-computation.tmLanguage.json"],
        },
    },
});

export default typeComputationPlugin;

const typeComputationKeywordDocumentation: Readonly<Record<string, string>> = {
    let: "Introduces a locally named intermediate type.",
    in: "Separates a local type binding from the type that consumes it.",
    match: "Selects the first matching type pattern.",
    infer: "Binds a type captured by a type-match pattern.",
};

interface SourceToken {
    readonly start: number;
    readonly length: number;
}

function quickInfo(token: SourceToken, display: string) {
    return { start: token.start, length: token.length, display };
}

function usefulDisplay(display: string | undefined): boolean {
    return !!display && !/\bany\b|\?\s*$|\(Missing\)/.test(display);
}

function scopedTypeBinding(sourceText: string, name: string): string | undefined {
    const escaped = escapeRegExp(name);
    const expression = new RegExp(`\\blet\\s+${escaped}\\s*=\\s*([\\s\\S]*?)\\s+in\\b`, "g");
    let match: RegExpExecArray | null;
    let value: string | undefined;
    while ((match = expression.exec(sourceText))) value = normalizeSource(match[1]);
    return value;
}

function isInferBinding(sourceText: string, position: number, name: string): boolean {
    const prefix = sourceText.slice(Math.max(0, position - 16), position);
    return /\binfer\s*$/.test(prefix) && /^[A-Za-z_$][\w$]*$/.test(name);
}

/** The alias whose type parameter list contains `position`, displayed with every parameter's kind. */
function typeParameterListOwnerAt(sourceText: string, position: number): string | undefined {
    const header = /\btype\s+([A-Za-z_$][\w$]*)\s*</g;
    let candidate: RegExpExecArray | null;
    let owner: string | undefined;
    while ((candidate = header.exec(sourceText)) && candidate.index < position) {
        const open = header.lastIndex - 1;
        let depth = 0;
        let close = -1;
        for (let index = open; index < sourceText.length && close < 0; index++) {
            const character = sourceText[index];
            if (character === ">" && sourceText[index - 1] === "=") continue;
            if ("<([".includes(character)) depth++;
            else if (">)]".includes(character) && --depth === 0) close = index;
        }
        const parameters = sourceText.slice(open + 1, close);
        // Plain TypeScript parameter lists keep the compiler's own hover.
        const kinded = splitTopLevelCommas(parameters).some(parameter => parameter.includes(":"));
        owner = kinded && open < position && position < close
            ? `type ${candidate[1]}<${normalizeKindParameters(parameters)}>`
            : owner;
    }
    return owner;
}

function propertyTypeAt(sourceText: string, position: number, name: string): string | undefined {
    const suffix = sourceText.slice(position + name.length);
    const match = /^\s*:\s*([^;,}\n]+)/.exec(suffix);
    return match?.[1].trim();
}

function enclosingTypeParameterOwner(sourceText: string, position: number, name: string): string | undefined {
    const prefix = sourceText.slice(0, position);
    const match = /\btype\s+([A-Za-z_$][\w$]*)\s*<([^;>{}]*)>[^;=]*=/g;
    let candidate: RegExpExecArray | null;
    let owner: string | undefined;
    while ((candidate = match.exec(prefix))) {
        if (new RegExp(`(?:^|,)\\s*${escapeRegExp(name)}(?:\\s*:|\\s*(?:,|$))`).test(candidate[2])) {
            owner = `type ${candidate[1]}<${normalizeKindParameters(candidate[2])}>`;
        }
    }
    return owner;
}

function typeLambdaAt(sourceText: string, position: number): {
    readonly name: string;
    readonly parameters: readonly string[];
    readonly declaration: string;
    readonly constructor: string;
} | undefined {
    const expression = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*(<([^>]*)>\s*=>>\s*[^;]+)\s*;/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(sourceText))) {
        if (match.index <= position && position <= expression.lastIndex) {
            const parameters = match[3].split(",").map(parameter => parameter.trim().split(/\s*:/)[0]);
            return {
                name: match[1],
                parameters,
                declaration: `${match[1]} = ${normalizeSource(match[2])}`,
                constructor: `<${normalizeKindParameters(match[3])}> =>>`,
            };
        }
    }
    return undefined;
}

function normalizeKindParameters(parameters: string): string {
    return splitTopLevelCommas(parameters).map(parameter => {
        const normalized = parameter.trim();
        return normalized.includes(":") ? normalized : `${normalized}: Type0`;
    }).join(", ");
}

function splitTopLevelCommas(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const character = text[index];
        if (character === ">" && text[index - 1] === "=") continue;
        if ("<([{".includes(character)) depth++;
        else if (">)]}".includes(character)) depth--;
        else if (character === "," && depth === 0) { parts.push(text.slice(start, index)); start = index + 1; }
    }
    return [...parts, text.slice(start)];
}

function normalizeSource(source: string): string {
    return source.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
