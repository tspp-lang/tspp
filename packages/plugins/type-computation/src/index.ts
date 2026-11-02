import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import type * as TS from "typescript-upstream";

import { createKindChecker } from "./checker";
import { createDeclarationRestorers } from "./declarations";
import { createTypeSyntaxModel, kindParameterOwner, universeQuickInfo } from "./kinds";
import { createTypeSyntax } from "./syntax";

const pluginId = "type-computation";

export const typeComputationPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Type computation and higher-kinded types",
        syntax: {
            keywords: [
                { keyword: "let", position: "type" },
                { keyword: "match", position: "type" },
                { keyword: "<", position: "type" },
                { keyword: ":", position: "type-parameter" },
                { keyword: "Type", position: "type" },
                { keyword: "<", position: "postfix-type" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const ts = context.ts;
                const model = createTypeSyntaxModel();
                const [typeSyntax, ...otherSyntax] = createTypeSyntax(ts, model);
                const restorers = createDeclarationRestorers(ts, model);
                const disposers = [
                    context.compiler.registerSyntaxExtension({ ...typeSyntax, ...restorers }),
                    ...otherSyntax.map(extension => context.compiler.registerSyntaxExtension(extension)),
                    context.compiler.registerTypeExtension(createKindChecker(ts, model)),
                    context.compiler.registerDiagnosticProvider({
                        id: "let-bindings",
                        getSemanticDiagnostics: () => [],
                        // A `let` binding lowers to an `infer` with no source text of its own; report on its name.
                        filterDiagnostic: diagnostic => {
                            if (diagnostic.length !== 0 || !diagnostic.file || diagnostic.start === undefined) return true;
                            const name = findLetBinding(ts, model, diagnostic.file, diagnostic.start);
                            if (!name) return true;
                            const length = ts.idText(name).length;
                            return { ...diagnostic, start: name.end - length, length };
                        },
                    }),
                ];
                return () => {
                    for (const dispose of disposers.reverse()) dispose();
                };
            },
        },
        languageService: {
            activate(context) {
                return context.languageService.registerQuickInfoProvider(request => {
                    const token = request.token;
                    if (!token) return undefined;
                    const universe = universeQuickInfo(token);
                    if (universe) return universe;
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
                    const kindOwner = kindParameterOwner(request.sourceText, token.start, token.text);
                    if (kindOwner) return quickInfo(token, `(type parameter) ${token.text} in ${kindOwner}`);
                    return undefined;
                });
            },
        },
        editor: {
            keywords: ["in", "infer"],
            grammars: ["./editor/type-computation.tmLanguage.json", "./editor/higher-kinded-types.tmLanguage.json"],
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

function findLetBinding(ts: typeof TS, model: ReturnType<typeof createTypeSyntaxModel>, sourceFile: TS.SourceFile, position: number) {
    let found: TS.Identifier | undefined;
    const visit = (node: TS.Node): void => {
        if (found || node.pos > position || node.end < position) return;
        found = node.pos === position ? model.letBindings.get(node) : undefined;
        if (!found) ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}
