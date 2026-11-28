import { maskNonCode } from "@tspp/plugin-sdk";

/**
 * A computed alias, or one whose signature takes a type or a kernel value, as in `type Describe = (A: Type, value: A) =>
 * string`, is shown in the TS++ syntax its author wrote, not as what it lowers to.
 */
export function computedAliasDisplay(name: string, sourceText: string): string | undefined {
    const code = maskNonCode(sourceText);
    const declaration = new RegExp(`\\btype\\s+${escapeRegExp(name)}\\b`, "g").exec(code);
    if (!declaration) return undefined;
    const equals = findTopLevel(code, declaration.index + declaration[0].length, index => code[index] === "=" && code[index + 1] !== ">");
    if (equals < 0) return undefined;
    const end = findTopLevel(code, equals + 1, index => code[index] === ";");
    const expression = code.slice(equals + 1, end < 0 ? code.length : end).trimStart();
    // A computed body, or a signature that takes a type or a value of the kernel, which lowers to generated parameters.
    const dependentSignature = /^[(<]/.test(expression) && /[(,]\s*[A-Za-z_$][\w$]*\s*:\s*(?:Type\d*|Nat|Bool)\b/.test(expression);
    if (!/^(?:match|let)\b/.test(expression) && !dependentSignature) return undefined;
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
        // The `>` of `=>` and of `=>>` closes nothing.
        else if (">)]}".includes(character) && !(character === ">" && (text[index - 1] === "=" || text.startsWith("=>", index - 2)))) depth--;
    }
    return -1;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
