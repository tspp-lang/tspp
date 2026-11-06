import type { TSPPQuickInfoProvider, TSPPQuickInfoRequest, TSPPSemanticToken, TSPPSemanticTokensRequest } from "@tspp/plugin-sdk/language-service";

const keywords: Record<string, string> = {
    typeclass: "Declares an ability that implementations provide for some types.",
    impl: "Declares an implementation of a typeclass, a value implicit search can find, or the inherent methods of a type.",
    where: "What a function requires: typeclasses, whose implementations it receives, and type predicates, which must reduce to `true`.",
};

/** The text of a balanced `<...>` opening at `open`, without the brackets. */
function angleContents(text: string, open: number): { readonly contents: string; readonly end: number; } | undefined {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === "<") depth++;
        else if (text[index] === ">" && text[index - 1] !== "=" && --depth === 0) return { contents: text.slice(open + 1, index), end: index };
    }
    return undefined;
}

/** The type parameters a declaration header before `position` lists, by the nearest such header. */
function typeParametersBefore(text: string, position: number): readonly string[] {
    let parameters = "";
    for (const match of text.slice(0, position).matchAll(/\b(?:function\s*\*?\s*[\w$]*|class\s+[\w$]+|interface\s+[\w$]+|type\s+[\w$]+|typeclass\s+[\w$]+|impl)\s*(<|\(|\b)/g)) {
        parameters = match[1] === "<" ? angleContents(text, match.index + match[0].length - 1)?.contents ?? "" : "";
    }
    return parameters.split(",").map(parameter => /^\s*([\w$]+)/.exec(parameter)?.[1] ?? "");
}

/** Whether `position` is in the `where <...>` clause of a declaration. */
function isInWhereClause(text: string, position: number): boolean {
    for (const match of text.matchAll(/[)\w>]\s*where\s*</g)) {
        const open = match.index + match[0].length - 1;
        if (open > position) return false;
        const clause = angleContents(text, open);
        if (clause && position <= clause.end) return true;
    }
    return false;
}

/** Whether `position` is in the header of an inherent `impl<...> Target<...> {`, which the tree holds no copy of at its place. */
function isInImplHeader(text: string, position: number): boolean {
    const lineStart = text.lastIndexOf("\n", position) + 1;
    return /^\s*(?:export\s+)?impl\b/.test(text.slice(lineStart, position + 1)) && !text.slice(lineStart, position).includes("{");
}

function typeclassHeader(text: string, name: string): string | undefined {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
    const match = new RegExp(`\\btypeclass\\s+${name.replace(/\$/g, "\\$")}\\b\\s*(<)?`).exec(text);
    if (!match) return undefined;
    const parameters = match[1] ? angleContents(text, match.index + match[0].length - 1)?.contents : undefined;
    return `typeclass ${name}${parameters === undefined ? "" : `<${parameters}>`}`;
}

/** Keywords and `where` items never reach the tree editor services read, and neither does the type parameter list of a typeclass's value. */
export const typeclassQuickInfo: TSPPQuickInfoProvider = (request: TSPPQuickInfoRequest) => {
    const token = request.token;
    if (!token) return undefined;
    const text = request.sourceText;
    const answer = (display: string, documentation?: string) => ({ start: token.start, length: token.length, display, documentation });
    if (request.owned && keywords[token.text] && (token.text !== "where" || isInWhereClause(text, token.start + token.length + 1))) {
        return answer(`(TS++ keyword) ${token.text}`, keywords[token.text]);
    }
    const upstream = request.upstream?.display;
    // An inherent method is declared on an interface that only exists in the lowering.
    if (request.owned && !upstream && /^\s*(?:<[^>]*>\s*)?\(\s*self\b/.test(text.slice(token.start + token.length))) return answer(`(method) ${token.text}`);
    const lowered = upstream && /^\(method\) ([\w$]+)\$impl\$\d+(?:<[^>]*>)?\.(.*)$/s.exec(upstream);
    if (lowered) return answer(`(method) ${lowered[1]}.${lowered[2]}`);
    if (upstream?.startsWith("(method)")) {
        // The owner is an interface that only exists in the lowering, and generated names have no text to print.
        if (upstream.includes("(Missing)")) {
            const signature = /(?:\(Missing\)|\])(\(.*)$/s.exec(upstream)?.[1] ?? "";
            return answer(`(method) ${token.text}${signature}`);
        }
        return undefined;
    }
    const header = typeclassHeader(text, token.text);
    if (header || /\btypeclass\s+$/.test(text.slice(0, token.start))) {
        if (upstream && /\binterface\s+/.test(upstream)) return answer(upstream.replace(/\binterface\b/, "typeclass"));
        return answer(header ?? `typeclass ${token.text}`);
    }
    if (upstream?.includes("(Missing)")) return answer(header ?? `typeclass ${token.text}`);
    if (isInImplHeader(text, token.start) || isInWhereClause(text, token.start)) {
        if (typeParametersBefore(text, token.start).includes(token.text)) return answer(`(type parameter) ${token.text}`);
        return upstream ? undefined : answer(header ?? `(constraint) ${token.text}`);
    }
    return undefined;
};

function isTypeclassName(request: TSPPSemanticTokensRequest, name: string): boolean {
    if (typeclassHeader(request.sourceText, name)) return true;
    const imported = request.imports.find(entry => entry.name === name);
    return !!imported && !!typeclassHeader(imported.sourceText, imported.importedName);
}

/** The names in `where` clauses and `impl` headers, which the tree the classifier reads does not hold there. */
export function typeclassSemanticTokens(request: TSPPSemanticTokensRequest): readonly TSPPSemanticToken[] {
    const text = request.sourceText;
    const tokens: TSPPSemanticToken[] = [];
    for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
        const start = match.index;
        if (!isInImplHeader(text, start) && !isInWhereClause(text, start)) continue;
        if (!request.isOwned(start, start + match[0].length) && !isInImplHeader(text, start)) continue;
        if (typeParametersBefore(text, start).includes(match[0])) tokens.push({ start, length: match[0].length, type: "typeParameter" });
        else if (isTypeclassName(request, match[0])) tokens.push({ start, length: match[0].length, type: "interface" });
    }
    return tokens;
}
