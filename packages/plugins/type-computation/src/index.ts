import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import { isTypeScriptKeyword, scanTSPPCode } from "@tspp/plugin-sdk/language-service";
import type { TSPPSemanticToken, TSPPSemanticTokensRequest } from "@tspp/plugin-sdk/language-service";
import type * as TS from "typescript-upstream";

import { createKindChecker } from "./checker";
import { createDeclarationRestorers } from "./declarations";
import { createNormalFormAnalyzer, createTermDiagnostics, dependentAliasAt, partialInferencePreprocessor } from "./dependent";
import { createReification } from "./reification";
import { builtinTermNames } from "./term-parser";
import { createTypeSyntaxModel, kindParameterOwner, universeQuickInfo } from "./kinds";
import { createTypeSyntax } from "./syntax";

const pluginId = "type-computation";

export const typeComputationPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Type computation, higher-kinded types, and dependent types",
        capabilities: ["analysis-artifacts", "dependent-types", "runtime-type-reification"],
        syntax: {
            keywords: [
                { keyword: "let", position: "type" },
                { keyword: "match", position: "type" },
                { keyword: "<", position: "type" },
                { keyword: "(", position: "type" },
                { keyword: "{", position: "type" },
                { keyword: "auto", position: "type" },
                ...builtinTermNames.map(keyword => ({ keyword, position: "type" as const })),
                { keyword: "reify", position: "expression" },
                { keyword: "typecase", position: "expression" },
                { keyword: ":", position: "type-parameter-annotation" },
                { keyword: ":", position: "type-alias-annotation" },
                { keyword: "Type", position: "type" },
                { keyword: "<", position: "postfix-type" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const ts = context.ts;
                const model = createTypeSyntaxModel(() => context.compiler.getSyntaxKeywords("declaration"));
                const [typeSyntax, ...otherSyntax] = createTypeSyntax(ts, model);
                const restorers = createDeclarationRestorers(ts, model, sourceFile => context.compiler.getAuthoredText(sourceFile));
                const reification = createReification(ts);
                const disposers = [
                    context.compiler.registerSyntaxExtension(reification.reify),
                    context.compiler.registerSyntaxExtension(reification.typecase),
                    context.compiler.registerProgramRebuilder(reification.selection),
                    context.compiler.registerSourcePreprocessor(partialInferencePreprocessor),
                    context.compiler.registerProgramAnalyzer(createNormalFormAnalyzer(ts, model)),
                    context.compiler.registerDiagnosticProvider(createTermDiagnostics(ts, model)),
                    context.compiler.registerSyntaxExtension({ ...typeSyntax, ...restorers }),
                    ...otherSyntax.map(extension => context.compiler.registerSyntaxExtension(extension)),
                    context.compiler.registerTypeExtension(createKindChecker(ts, model)),
                    context.compiler.registerDiagnosticProvider({
                        id: "let-bindings",
                        getSemanticDiagnostics: () => [],
                        // A `let` binding lowers to an `infer` whose range runs over the bound value; report on its name.
                        filterDiagnostic: diagnostic => {
                            if (!diagnostic.file || diagnostic.start === undefined) return true;
                            const name = findLetBinding(ts, model, diagnostic.file, diagnostic.start);
                            if (!name) return true;
                            const length = ts.idText(name).length;
                            // Under its own code: the fixes for an unused name would delete a type parameter from a list it isn't in.
                            return { ...diagnostic, start: name.end - length, length, code: letBindingDiagnosticCode };
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
                context.onDispose(context.languageService.registerSemanticTokensProvider(typeLevelSemanticTokens));
                return context.languageService.registerQuickInfoProvider(request => {
                    // `auto` is blanked before parsing, so it is no token of the tree.
                    if (/^auto(?![\w$])/.test(request.sourceText.slice(request.position, request.position + 5)) && request.sourceText[request.position - 1] !== ".") {
                        return { start: request.position, length: 4, display: "(TS++ keyword) auto", documentation: "Lets the checker infer this type argument." };
                    }
                    const alias = request.owned ? dependentAliasAt(request.sourceText, request.position) : undefined;
                    if (alias) {
                        return {
                            start: alias.nameStart,
                            length: alias.nameEnd - alias.nameStart,
                            display: alias.display,
                            documentation: "A type alias annotated with its kind or type, checked by the type theory's kernel.",
                        };
                    }
                    const token = request.token;
                    if (!token) return undefined;
                    if (request.owned && reificationDocumentation[token.text]) {
                        return {
                            start: token.start,
                            length: token.length,
                            display: `(TS++ dependent types) ${token.text}`,
                            documentation: reificationDocumentation[token.text],
                        };
                    }
                    const universe = universeQuickInfo(token);
                    if (universe) return universe;
                    const authored = authoredQuickInfo(token, request.upstream?.display, request.sourceText);
                    if (authored) return authored;
                    // A name only the kernel reads, such as a binder of a dependent type, has no TypeScript symbol to show.
                    const unbound = !request.upstream || request.upstream.display === "any";
                    if (unbound && kernelConstants.has(token.text)) return { start: token.start, length: token.length, display: `(type-level constant) ${token.text}` };
                    if (request.owned && token.text === "_") return { start: token.start, length: token.length, display: "(wildcard pattern) _" };
                    if (request.owned && unbound && !reificationDocumentation[token.text]
                        && /^[A-Za-z_$][\w$]*$/.test(token.text) && !["let", "in", "match", "infer"].includes(token.text)) {
                        return { start: token.start, length: token.length, display: `(type-level name) ${token.text}` };
                    }
                    if (request.owned && ["let", "in", "match", "infer"].includes(token.text)) {
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
            artifactViews: [{
                commandId: "tspp.showMlttNormalForms",
                title: "TS++: Show MLTT Normal Forms",
                label: "MLTT normal forms",
                artifactKind: "type-computation/normal-form",
                emptyMessage: "This file has no MLTT normal forms.",
            }],
            grammars: ["./editor/type-computation.tmLanguage.json", "./editor/higher-kinded-types.tmLanguage.json", "./editor/dependent-types.tmLanguage.json"],
        },
    },
});

export default typeComputationPlugin;
export { inferDependentTypeUniverse, parseDependentType } from "./dependent";

const reificationDocumentation: Readonly<Record<string, string>> = {
    reify: "Creates a runtime descriptor for the following static type.",
    typecase: "Matches a runtime type descriptor against type patterns in order.",
};

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

const kernelConstants = new Set(["Bool", "True", "False", "BoolElim", "If", "Nat", "Zero", "Succ", "NatAdd", "NatElim", "Eq", "Refl", "J", "Sigma", "Pair", "First", "Second", "Lam", "Ann"]);

/**
 * Names the kernel reads have no TypeScript symbol, so nothing classifies them: all binders render alike here, and so do
 * all constants. Anything the language service did classify keeps its token.
 */
function typeLevelSemanticTokens(request: TSPPSemanticTokensRequest): TSPPSemanticToken[] {
    const classified = new Set(request.tokens.map(token => token.start));
    const tokens: TSPPSemanticToken[] = [];
    let previous: string | undefined;
    for (const token of scanTSPPCode(request.sourceText)) {
        const afterInfer = previous === "infer";
        previous = token.kind === "name" ? token.text : undefined;
        if (token.kind !== "name" || classified.has(token.start)) continue;
        const end = token.start + token.text.length;
        if (request.sourceText[token.start - 1] === "." && request.sourceText[token.start - 2] !== ".") continue;
        if (kernelConstants.has(token.text)) tokens.push({ start: token.start, length: token.text.length, type: "type" });
        else if (afterInfer || (token.text !== "_" && !/^Type\d*$/.test(token.text) && !isTypeScriptKeyword(token.text) && !["match", "reify", "typecase", "auto"].includes(token.text) && request.isOwned(token.start, end))) {
            tokens.push({ start: token.start, length: token.text.length, type: "typeParameter" });
        }
    }
    return tokens;
}

/** Type-level syntax shown as it was written: what it lowers to, with generated parameters and conditionals, is no one's code. */
function authoredQuickInfo(token: { readonly start: number; readonly length: number; readonly text: string; }, display: string | undefined, sourceText: string) {
    const shown = (text: string) => ({ start: token.start, length: token.length, display: text });
    if (display && /\b_?_tspp_/.test(display)) return shown(display.replace(/\n\s*(?:readonly )?__tspp\w*[^\n]*/g, "").replace(/ in <[\s\S]*$/, ""));
    if (display?.startsWith(`type ${token.text}`) && /\bextends\b/.test(display)) {
        const declaration = new RegExp(`\\btype\\s+${escapeRegExp(token.text)}\\b[^\\n]*?=\\s*(?:match|let)\\b[^\\n]*`).exec(sourceText);
        if (declaration) return shown(declaration[0].trimEnd());
    }
    return undefined;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The code of plugin diagnostics without a code of their own. */
const letBindingDiagnosticCode = 18086;

function findLetBinding(ts: typeof TS, model: ReturnType<typeof createTypeSyntaxModel>, sourceFile: TS.SourceFile, position: number) {
    let found: TS.Identifier | undefined;
    const visit = (node: TS.Node): void => {
        if (found || node.pos > position || node.end < position) return;
        const name = model.letBindings.get(node);
        found = name?.getStart(sourceFile) === position ? name : undefined;
        if (!found) ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found;
}
