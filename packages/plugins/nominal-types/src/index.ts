import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
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
                const matches = createValueMatches(context.ts);
                context.onDispose(context.compiler.registerSyntaxExtension(declarations.extension));
                context.onDispose(context.compiler.registerSyntaxExtension(matches.extension));
                return context.compiler.registerDiagnosticProvider(createNominalDiagnostics(context.ts, declarations, matches));
            },
        },
        languageService: {
            activate(context) {
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
                    return undefined;
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
