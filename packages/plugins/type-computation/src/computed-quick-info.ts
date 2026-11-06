import { maskNonCode } from "@tspp/plugin-sdk";

/** A computed alias is shown in the TS++ syntax its author wrote, through the end of its `match` or `let` body. */
export function computedAliasDisplay(name: string, sourceText: string): string | undefined {
    const code = maskNonCode(sourceText);
    const declaration = new RegExp(`\\btype\\s+${escapeRegExp(name)}\\b`, "g").exec(code);
    if (!declaration) return undefined;
    const equals = findTopLevel(code, declaration.index + declaration[0].length, index => code[index] === "=" && code[index + 1] !== ">");
    if (equals < 0) return undefined;
    const expression = code.slice(equals + 1).trimStart();
    if (!/^(?:match|let)\b/.test(expression)) return undefined;
    const end = findTopLevel(code, equals + 1, index => code[index] === ";");
    const text = sourceText.slice(declaration.index, end < 0 ? sourceText.length : end).trimEnd();
    const lineStart = sourceText.lastIndexOf("\n", declaration.index - 1) + 1;
    const indent = /^\s*/.exec(sourceText.slice(lineStart, declaration.index))?.[0] ?? "";
    return indent ? text.split("\n").map((line, index) => index && line.startsWith(indent) ? line.slice(indent.length) : line).join("\n") : text;
}

/** Finds a character outside all type delimiters. */
function findTopLevel(text: string, start: number, accepts: (index: number) => boolean): number {
    let depth = 0;
    for (let index = start; index < text.length; index++) {
        const character = text[index];
        if (depth === 0 && accepts(index)) return index;
        if ("<([{".includes(character)) depth++;
        else if (">)]}".includes(character) && !(character === ">" && text[index - 1] === "=")) depth--;
    }
    return -1;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
