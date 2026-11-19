import { dataProperties } from "./representation";
import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import { formatTSPPSyntax } from "@tspp/plugin-sdk/language-service";
import type { TSPPClearedSemanticToken, TSPPSemanticToken, TSPPSemanticTokensRequest } from "@tspp/plugin-sdk/language-service";
import { getDataDeclarationSources, nominalTypesADTAPI, nominalTypesADTAPIName } from "./adt";
import { createNominalDeclarations } from "./declarations";
import { createNominalDiagnostics } from "./diagnostics";
import { createValueMatches } from "./match";
import { createGadtMatches } from "./gadt-match";
import { createGadtInference } from "./gadt-inference";

const pluginId = "nominal-types";

export const nominalTypesPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.0",
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
                const matchTypes = createGadtMatches(context.ts, declarations, matches);
                const inference = createGadtInference(context.ts, declarations);
                context.onDispose(context.compiler.registerTypeExtension({
                    ...matchTypes,
                    resolveExpressionType: (node, host) => matchTypes.resolveExpressionType?.(node, host)
                        ?? inference.resolveExpressionType?.(node, host),
                }));
                return context.compiler.registerDiagnosticProvider(createNominalDiagnostics(context.ts, declarations, matches));
            },
        },
        languageService: {
            activate(context) {
                context.onDispose(context.languageService.registerFormattingProvider(formatTSPPSyntax));
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
    readonly typeParameters?: readonly string[];
    readonly resultType?: string;
    readonly callable?: boolean;
}

type SourcePosition = number & { readonly __brand: "SourcePosition"; };
const SourcePosition = (value: number) => value as SourcePosition;
type RelativeOffset = number & { readonly __brand: "RelativeOffset"; };
const RelativeOffset = (value: number) => value as RelativeOffset;

interface SourceTypeParameter {
    readonly name: string;
    readonly constraint?: string;
    readonly start: SourcePosition;
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
    const valuesPattern = new RegExp(`\\b${escapeRegExp(dataProperties.values)}\\b`);
    if (!display || !valuesPattern.test(display) || valuesPattern.test(sourceText)) return undefined;
    const shown = display
        .replace(new RegExp(`\\{\\s*readonly ${escapeRegExp(dataProperties.tag)}: "([^"]+)";(?:[^{}]|\\{[^{}]*\\})*\\}`, "g"), "$1")
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
    return getDataDeclarationSources(sourceText).map(source => ({
        name: source.data.name,
        parameters: parseSourceParameters(source.parameterText, SourcePosition(source.parameterStart)),
        variants: source.data.variants,
        display: `data ${source.data.name}${source.parameterText ? `<${normalizeSource(source.parameterText)}>` : ""} ${source.braced
            ? `{ ${normalizeSource(source.body)} }` : `= ${normalizeSource(source.body)}`}`,
    }));
}

/** A word in the body of a `data` or `newtype` that names one of its type parameters, which lowering moved to generated functions. */
function findTypeParameterInDeclaration(sourceText: string, token: SourceToken & { readonly text: string; }): boolean {
    for (const source of getDataDeclarationSources(sourceText)) {
        if (source.start <= token.start && token.start < source.end && source.data.typeParameters.includes(token.text)) return true;
    }
    for (const match of sourceText.matchAll(/\b(?:data|newtype)\s+[A-Za-z_$][\w$]*\s*<([^;=]+)>\s*=[^;]*;/g)) {
        if (token.start < match.index || token.start >= match.index + match[0].length) continue;
        if (splitTopLevel(match[1], ",").some(parameter => parameter.trim().split(/[\s:]/)[0] === token.text)) return true;
    }
    return false;
}

function findDeclarationTypeParameter(sourceText: string, token: SourceToken): SourceTypeParameter | undefined {
    for (const source of getDataDeclarationSources(sourceText)) {
        const parameter = parseSourceParameters(source.parameterText, SourcePosition(source.parameterStart)).find(candidate =>
            candidate.start === token.start && candidate.length === token.length);
        if (parameter) return parameter;
    }
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

function advancePosition(position: SourcePosition, offset: RelativeOffset): SourcePosition {
    return SourcePosition(position + offset);
}

function parseTypeParameters(match: RegExpExecArray, captureIndex: number): readonly SourceTypeParameter[] {
    const source = match[captureIndex];
    if (!source) return [];
    const sourceOffset = match[0].indexOf(source);
    if (sourceOffset < 0) return [];
    const captureStart = advancePosition(SourcePosition(match.index), RelativeOffset(sourceOffset));
    return parseSourceParameters(source, captureStart);
}

function parseSourceParameters(source: string, captureStart: SourcePosition): readonly SourceTypeParameter[] {
    return splitTopLevelWithOffsets(source, ",").flatMap(part => {
        const parsed = /^\s*([A-Za-z_$][\w$]*)(?:\s*(?::|extends)\s*([\s\S]+)|\s*=[\s\S]+)?\s*$/.exec(part.text);
        if (!parsed) return [];
        const nameOffset = RelativeOffset(part.text.indexOf(parsed[1]));
        return [{
            name: parsed[1],
            constraint: parsed[2]?.trim(),
            start: advancePosition(advancePosition(captureStart, part.offset), nameOffset),
            length: parsed[1].length,
        }];
    });
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
    const result = variant.resultType ?? `${declaration.name}${resultArguments.length ? `<${resultArguments.join(", ")}>` : ""}`;
    const fields = variant.fields.map(field => `${field.name}: ${substitutions.get(field.type) ?? field.type}`).join(", ");
    const parameters = variant.typeParameters?.length ? `<${variant.typeParameters.join(", ")}>` : variant.resultType || argumentsAtUse
        ? ""
        : declaration.parameters.length ? `<${declaration.parameters.map(parameter => parameter.name).join(", ")}>` : "";
    return `(data constructor) ${variant.name}${parameters}${fields || variant.callable ? `(${fields})` : ""}: ${result}`;
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

function splitTopLevelWithOffsets(source: string, separator: string): { readonly text: string; readonly offset: RelativeOffset; }[] {
    const parts: { readonly text: string; readonly offset: RelativeOffset; }[] = [];
    let start = 0;
    let depth = 0;
    for (let index = 0; index < source.length; index++) {
        const character = source[index];
        if ("(<[{".includes(character)) depth++;
        else if (")>]}".includes(character)) depth--;
        else if (character === separator && depth === 0) {
            parts.push({ text: source.slice(start, index), offset: RelativeOffset(start) });
            start = index + 1;
        }
    }
    parts.push({ text: source.slice(start), offset: RelativeOffset(start) });
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
