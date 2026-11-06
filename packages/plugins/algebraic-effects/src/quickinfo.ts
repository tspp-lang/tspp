import { scanTSPPCode } from "@tspp/plugin-sdk/language-service";
import type { TSPPQuickInfoProvider, TSPPSemanticToken, TSPPSemanticTokensRequest } from "@tspp/plugin-sdk/language-service";

const keywords: Record<string, string> = {
    effect: "Declares an effect: operations whose meaning the enclosing `handle` gives.",
    perform: "Calls an operation of an effect, through the handler in scope.",
    handle: "Gives the operations of an effect a meaning in the code after `in`.",
    suspend: "Marks an operation whose handler takes the continuation `k`, and may go on with it later.",
    control: "A handler clause that takes the continuation `k` as its last argument, and resumes or aborts it once.",
};

/** The word of source text around `position`. */
function wordAt(text: string, position: number): { readonly start: number; readonly text: string; } | undefined {
    let start = position;
    while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
    const word = /^[A-Za-z_$][\w$]*/.exec(text.slice(start));
    return word && position <= start + word[0].length ? { start, text: word[0] } : undefined;
}

/** The text of a balanced `<...>` opening at `open`, without the brackets. */
function angleContents(text: string, open: number): { readonly contents: string; readonly end: number; } | undefined {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === "<") depth++;
        else if (text[index] === ">" && text[index - 1] !== "=" && --depth === 0) return { contents: text.slice(open + 1, index), end: index };
    }
    return undefined;
}

function effectHeader(text: string, name: string): string | undefined {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
    const match = new RegExp(`\\beffect\\s+${name.replace(/\$/g, "\\$")}\\b\\s*(<)?`).exec(text);
    if (!match) return undefined;
    const parameters = match[1] ? angleContents(text, match.index + match[0].length - 1)?.contents : undefined;
    return `effect ${name}${parameters === undefined ? "" : `<${parameters}>`}`;
}

/** Keywords never reach the tree editor services read, and a position on one may touch what it lowered to. */
export const effectQuickInfo: TSPPQuickInfoProvider = request => {
    const word = wordAt(request.sourceText, request.position);
    if (word && request.owned && keywords[word.text]) {
        // Inside this plugin's syntax, the same word followed by a name is the keyword; anything else is a name of that spelling.
        if (/^[ \t]+[A-Za-z_$]/.test(request.sourceText.slice(word.start + word.text.length))) {
            return { start: word.start, length: word.text.length, display: `(TS++ keyword) ${word.text}`, documentation: keywords[word.text] };
        }
    }
    const token = request.token ?? (word && { start: word.start, length: word.text.length, text: word.text });
    if (!token) return undefined;
    const text = request.sourceText;
    const upstream = request.upstream?.display;
    const answer = (display: string, documentation?: string) => ({ start: token.start, length: token.length, display, documentation });

    const header = effectHeader(text, token.text);
    if (header && upstream && /\binterface\s+/.test(upstream)) {
        return answer(upstream.replace(/\binterface\b/, "effect"));
    }
    if (request.owned && /\beffect\s+$/.test(text.slice(0, token.start))) {
        if (upstream && /\binterface\s+/.test(upstream)) return answer(upstream.replace(/\binterface\b/, "effect"));
        return answer(header ?? `effect ${token.text}`);
    }
    if (upstream?.includes("(Missing)")) return answer(header ?? `effect ${token.text}`);
    return undefined;
};

function declaresEffect(text: string, name: string): boolean {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return false;
    return new RegExp(`\\beffect\\s+${name.replace(/\$/g, "\\$")}\\b`).test(text);
}

function isEffectName(request: TSPPSemanticTokensRequest, name: string): boolean {
    if (declaresEffect(request.sourceText, name)) return true;
    const imported = request.imports.find(entry => entry.name === name);
    return !!imported && declaresEffect(imported.sourceText, imported.importedName);
}

/**
 * The effect names after `handle` and `perform` and in clauses, which a grammar reads as a function or a variable because
 * of what follows them. A clause is whatever stands between a `/` right after `)` and what ends the signature.
 */
export function effectSemanticTokens(request: TSPPSemanticTokensRequest): readonly TSPPSemanticToken[] {
    const text = request.sourceText;
    const tokens: TSPPSemanticToken[] = [];
    const add = (start: number, name: string) => {
        if (request.isOwned(start, start + name.length) && isEffectName(request, name)) tokens.push({ start, length: name.length, type: "interface" });
    };
    let previous: { readonly text: string; readonly start: number; } | undefined;
    for (const token of scanTSPPCode(text)) {
        if (token.kind === "name") {
            if (previous?.text === "handle" || previous?.text === "perform") add(token.start, token.text);
            else if (isInClause(text, token.start)) add(token.start, token.text);
        }
        previous = token;
    }
    return tokens;
}

/** Whether `position` is among the items of `) / item` or `) / { items }`. */
function isInClause(text: string, position: number): boolean {
    const line = text.slice(text.lastIndexOf("\n", position) + 1, position);
    const clause = /\)\s*\/\s*(\{[^}]*|[A-Za-z_$][\w$.]*(?:<[^>]*>?)?)?$/.exec(line);
    return !!clause && !/<[^>]*$/.test(clause[1] ?? "");
}
