import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type { TSPPClearedSemanticToken, TSPPSemanticToken, TSPPSemanticTokensRequest } from "@tspp/plugin-sdk/language-service";
import { nominalTypesADTAPI, nominalTypesADTAPIName } from "./adt";
import { createNominalDeclarations } from "./declarations";
import { createNominalDiagnostics } from "./diagnostics";
import { createValueMatches } from "./match";

const pluginId = "nominal-types";

export const nominalTypesPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.1",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Nominal types",
        provides: [nominalTypesADTAPIName],
        syntax: {
            keywords: [
                { keyword: "newtype", position: "declaration" },
                { keyword: "data", position: "declaration" },
                { keyword: "match", position: "expression" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                context.provide(nominalTypesADTAPIName, nominalTypesADTAPI);
                const declarations = createNominalDeclarations(context.ts);
                const matches = createValueMatches(context.ts, () => [
                    ...context.compiler.getSyntaxKeywords("primary-expression"),
                    ...context.compiler.getSyntaxKeywords("argument"),
                ]);
                context.onDispose(context.compiler.registerSyntaxExtension(declarations.extension));
                context.onDispose(context.compiler.registerSyntaxExtension(matches.extension));
                return context.compiler.registerDiagnosticProvider(createNominalDiagnostics(context.ts, declarations, matches));
            },
        },
        languageService: {
            activate(context) {
                context.onDispose(context.languageService.registerSemanticTokensProvider(nominalSemanticTokens));
                return context.languageService.registerQuickInfoProvider(request => {
                    const token = request.token;
                    if (!token) return undefined;
                    if (request.owned && ["newtype", "data", "match"].includes(token.text)) {
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(TS++ keyword) ${token.text}`,
                            documentation: nominalKeywordDocumentation[token.text],
                        };
                    }

                    const declarationParameter = findDeclarationTypeParameter(request.sourceText, token);
                    if (declarationParameter) {
                        return quickInfo(
                            token,
                            `(type parameter) ${declarationParameter.name}${declarationParameter.constraint
                                ? `: ${declarationParameter.constraint}`
                                : ""}`,
                        );
                    }

                    const parameterInBody = !/^\s*\(/.test(request.sourceText.slice(token.start + token.length)) && findTypeParameterInDeclaration(request.sourceText, token);
                    if (parameterInBody) return quickInfo(token, `(type parameter) ${token.text}`);
                    if (request.owned && token.text === "_") return quickInfo(token, "(wildcard pattern) _");
                    // An arm that can't match, as after narrowing, binds a name with no type to show.
                    if (request.owned && request.upstream?.display === `(parameter) ${token.text}: any`) return quickInfo(token, `(pattern binding) ${token.text}`);

                    const newtype = findNewtype(request.sourceText, token.text);
                    if (newtype) {
                        const called = /^\s*\(/.test(request.sourceText.slice(token.start + token.length));
                        return {
                            start: token.start,
                            length: token.length,
                            display: called
                                ? `(newtype constructor) ${newtype.name}(value: ${newtype.underlying}): ${newtype.name}`
                                : `newtype ${newtype.name}${newtype.parameters} = ${newtype.underlying}`,
                        };
                    }

                    for (const declaration of findDataDeclarations(request.sourceText)) {
                        if (token.text === declaration.name) {
                            return quickInfo(token, declaration.display);
                        }
                        const variant = declaration.variants.find(candidate => candidate.name === token.text);
                        if (!variant) continue;
                        return quickInfo(
                            token,
                            formatVariantQuickInfo(declaration, variant, instantiationAt(request.sourceText, token.start, declaration)),
                        );
                    }
                    return hideRepresentation(token, request.upstream?.display, request.sourceText);
                });
            },
        },
        editor: {
            grammars: ["./editor/nominal-types.tmLanguage.json"],
        },
    },
});

export default nominalTypesPlugin;

const nominalKeywordDocumentation: Readonly<Record<string, string>> = {
    newtype: "Declares an erased nominal type with a checked constructor.",
    data: "Declares a nominal algebraic data type and its runtime constructors.",
    match: "Exhaustively matches a value by data constructor.",
};

interface SourceToken {
    readonly start: number;
    readonly length: number;
}

interface SourceVariant {
    readonly name: string;
    readonly fields: readonly { readonly name: string; readonly type: string; }[];
}

interface SourceTypeParameter {
    readonly name: string;
    readonly constraint?: string;
    readonly start: number;
    readonly length: number;
}

interface SourceDataDeclaration {
    readonly name: string;
    readonly parameters: readonly SourceTypeParameter[];
    readonly variants: readonly SourceVariant[];
    readonly display: string;
}

function quickInfo(token: SourceToken, display: string) {
    return { start: token.start, length: token.length, display };
}

function findNewtype(sourceText: string, name: string): {
    readonly name: string;
    readonly parameters: string;
    readonly underlying: string;
} | undefined {
    const escaped = escapeRegExp(name);
    const match = new RegExp(`\\bnewtype\\s+${escaped}(\\s*<[^;=]+>)?\\s*=\\s*([^;]+)\\s*;`).exec(sourceText);
    return match ? { name, parameters: match[1]?.replace(/\s+/g, " ") ?? "", underlying: match[2].trim() } : undefined;
}

/**
 * A value of a `data` type is shown by its constructor: the object behind it, with its `_tag` and `_values`, is how it
 * lowers. Sources that spell `_tag` themselves work with that object, so they keep seeing it.
 */
function hideRepresentation(token: SourceToken, display: string | undefined, sourceText: string) {
    if (!display || !/\b_values\b/.test(display) || /\b_values\b/.test(sourceText)) return undefined;
    const shown = display
        .replace(/\{\s*readonly _tag: "([^"]+)";(?:[^{}]|\{[^{}]*\})*\}/g, "$1")
        .replace(/\(([A-Za-z_$][\w$]*)\)/g, "$1");
    return { start: token.start, length: token.length, display: shown };
}

const typeLikeTokens = new Set<string>(["class", "enum", "interface", "namespace", "typeParameter", "type"]);

/**
 * Constructors of `data` and `newtype` are one kind of name wherever they appear, but much of their use is in patterns and
 * declarations the language service never classified. A name that is also a type keeps what it was classified as there.
 */
function nominalSemanticTokens(request: TSPPSemanticTokensRequest): (TSPPSemanticToken | TSPPClearedSemanticToken)[] {
    // A wildcard binds nothing, though it lowers to a parameter.
    const keywords = request.tokens.filter(token => {
        const word = request.sourceText.slice(token.start, token.start + token.length);
        return word === "match" || word === "_" && request.isOwned(token.start, token.start + 1);
    });
    return [...keywords.map(token => ({ start: token.start, length: token.length, type: "none" as const })), ...constructorTokens(request)];
}

function constructorTokens(request: TSPPSemanticTokensRequest): TSPPSemanticToken[] {
    const constructorsIn = (sourceText: string) => [
        ...findDataDeclarations(sourceText).flatMap(declaration => declaration.variants.map(variant => variant.name)),
        ...[...sourceText.matchAll(/\bnewtype\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]),
    ];
    const constructors = new Set(constructorsIn(request.sourceText));
    for (const { name, importedName, sourceText } of request.imports) {
        if (constructorsIn(sourceText).includes(importedName)) constructors.add(name);
    }
    if (!constructors.size) return [];
    const typeLike = new Map(request.tokens.map(token => [token.start, typeLikeTokens.has(token.type)]));
    const tokens: TSPPSemanticToken[] = [];
    for (const match of request.sourceText.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`|[A-Za-z_$][\w$]*/g)) {
        const start = match.index;
        // Followed by arguments it is the constructor, even where a type parameter of the same name is in scope.
        const called = /^\s*\(/.test(request.sourceText.slice(start + match[0].length, start + match[0].length + 8));
        if (!constructors.has(match[0]) || request.sourceText[start - 1] === "." || typeLike.get(start) && !called) continue;
        if (!called && findTypeParameterInDeclaration(request.sourceText, { start, length: match[0].length, text: match[0] })) {
            tokens.push({ start, length: match[0].length, type: "typeParameter" });
            continue;
        }
        const declaresType = /\b(?:data|newtype)\s+$/.test(request.sourceText.slice(Math.max(0, start - 16), start));
        tokens.push({ start, length: match[0].length, type: declaresType ? "type" : "function" });
    }
    return tokens;
}

function findDataDeclarations(sourceText: string): readonly SourceDataDeclaration[] {
    const declarations: SourceDataDeclaration[] = [];
    const expression = /\bdata\s+([A-Za-z_$][\w$]*)(\s*<([^;=]+)>)?\s*=\s*([\s\S]*?)\s*;/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(sourceText))) {
        const parameters = parseTypeParameters(match, 3);
        const variants = splitTopLevel(match[4], "|").map(parseVariant).filter((value): value is SourceVariant => !!value);
        declarations.push({
            name: match[1],
            parameters,
            variants,
            display: `data ${match[1]}${match[2]?.replace(/\s+/g, " ") ?? ""} = ${normalizeSource(match[4])}`,
        });
    }
    return declarations;
}

/** A word in the body of a `data` or `newtype` that names one of its type parameters, which lowering moved to generated functions. */
function findTypeParameterInDeclaration(sourceText: string, token: SourceToken & { readonly text: string; }): boolean {
    for (const match of sourceText.matchAll(/\b(?:data|newtype)\s+[A-Za-z_$][\w$]*\s*<([^;=]+)>\s*=[^;]*;/g)) {
        if (token.start < match.index || token.start >= match.index + match[0].length) continue;
        if (splitTopLevel(match[1], ",").some(parameter => parameter.trim().split(/[\s:]/)[0] === token.text)) return true;
    }
    return false;
}

function findDeclarationTypeParameter(sourceText: string, token: SourceToken): SourceTypeParameter | undefined {
    const expression = /\b(?:data|newtype)\s+[A-Za-z_$][\w$]*(\s*<([^;=]+)>)?\s*=/g;
    let match: RegExpExecArray | null;
    while ((match = expression.exec(sourceText))) {
        const parameter = parseTypeParameters(match, 2).find(candidate =>
            candidate.start === token.start && candidate.length === token.length,
        );
        if (parameter) return parameter;
    }
    return undefined;
}

function parseTypeParameters(match: RegExpExecArray, captureIndex: number): readonly SourceTypeParameter[] {
    const source = match[captureIndex];
    if (!source) return [];
    const sourceOffset = match[0].indexOf(source);
    if (sourceOffset < 0) return [];
    return splitTopLevelWithOffsets(source, ",").flatMap(part => {
        const parsed = /^\s*([A-Za-z_$][\w$]*)(?:\s*:\s*([\s\S]+))?\s*$/.exec(part.text);
        if (!parsed) return [];
        const nameOffset = part.text.indexOf(parsed[1]);
        return [{
            name: parsed[1],
            constraint: parsed[2]?.trim(),
            start: match.index + sourceOffset + part.start + nameOffset,
            length: parsed[1].length,
        }];
    });
}

function parseVariant(source: string): SourceVariant | undefined {
    const match = /^\s*([A-Za-z_$][\w$]*)(?:\s*\(([\s\S]*)\))?\s*$/.exec(source);
    if (!match) return undefined;
    const fields = match[2]
        ? splitTopLevel(match[2], ",").map(field => {
            const separator = field.indexOf(":");
            return separator < 0 ? undefined : {
                name: field.slice(0, separator).trim(),
                type: field.slice(separator + 1).trim(),
            };
        }).filter((value): value is { readonly name: string; readonly type: string; } => !!value)
        : [];
    return { name: match[1], fields };
}

function formatVariantQuickInfo(
    declaration: SourceDataDeclaration,
    variant: SourceVariant,
    argumentsAtUse: readonly string[] | undefined,
): string {
    const substitutions = new Map<string, string>();
    declaration.parameters.forEach((parameter, index) => {
        const argument = argumentsAtUse?.[index];
        if (argument) substitutions.set(parameter.name, argument);
    });
    const resultArguments = declaration.parameters.map(parameter => substitutions.get(parameter.name) ?? parameter.name);
    const result = `${declaration.name}${resultArguments.length ? `<${resultArguments.join(", ")}>` : ""}`;
    const fields = variant.fields.map(field => `${field.name}: ${substitutions.get(field.type) ?? field.type}`).join(", ");
    const parameters = argumentsAtUse
        ? ""
        : declaration.parameters.length ? `<${declaration.parameters.map(parameter => parameter.name).join(", ")}>` : "";
    return `(data constructor) ${variant.name}${parameters}${fields ? `(${fields})` : ""}: ${result}`;
}

function instantiationAt(
    sourceText: string,
    position: number,
    declaration: SourceDataDeclaration,
): readonly string[] | undefined {
    const start = Math.max(sourceText.lastIndexOf(";", position - 1), sourceText.lastIndexOf("\n", position - 1)) + 1;
    const end = sourceText.indexOf(";", position);
    const statement = sourceText.slice(start, end < 0 ? sourceText.length : end);
    const escaped = escapeRegExp(declaration.name);
    const match = new RegExp(`:\\s*${escaped}\\s*<([^>]+)>`).exec(statement);
    return match?.[1].split(",").map(argument => argument.trim());
}

function splitTopLevel(source: string, separator: string): string[] {
    return splitTopLevelWithOffsets(source, separator).map(part => part.text);
}

function splitTopLevelWithOffsets(source: string, separator: string): { readonly text: string; readonly start: number; }[] {
    const parts: { readonly text: string; readonly start: number; }[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if ("(<[{".includes(character)) depth++;
        else if (")>]}".includes(character)) depth--;
        else if (character === separator && depth === 0) {
            parts.push({ text: source.slice(start, index), start });
            start = index + 1;
        }
    }
    parts.push({ text: source.slice(start), start });
    return parts;
}

function normalizeSource(source: string): string {
    return source.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export { nominalTypesADTAPI };
export type * from "./api";
