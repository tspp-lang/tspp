const regexPrecedingKeywords = new Set([
    "return", "typeof", "instanceof", "in", "of", "void", "delete", "case", "do", "else", "yield", "await", "throw", "new",
]);

/**
 * A copy of `text`, the same length and with the same line breaks, in which comments, string literals, the text of
 * template literals, and regular expressions are blank. Plugins that scan source text search this copy, so words inside
 * a string or a comment are never taken for syntax; the offsets it gives apply to `text`.
 */
export function maskNonCode(text: string): string {
    const characters = text.split("");
    const blank = (start: number, end: number) => {
        for (let index = start; index < end && index < characters.length; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
    };
    /** Blanks template text from `start`, a backtick or `}`, up to and including its closing backtick or `${`; returns what follows. */
    const scanTemplate = (start: number): number => {
        let index = start + 1;
        while (index < text.length) {
            if (text[index] === "\\") index += 2;
            else if (text[index] === "`") {
                blank(start, index + 1);
                return index + 1;
            }
            else if (text[index] === "$" && text[index + 1] === "{") {
                blank(start, index + 2);
                templateDepths.push(braceDepth);
                return index + 2;
            }
            else index++;
        }
        blank(start, text.length);
        return text.length;
    };
    const regexEnd = (start: number): number | undefined => {
        let inClass = false;
        for (let index = start + 1; index < text.length; index++) {
            const character = text[index];
            if (character === "\n" || character === "\r") return undefined;
            if (character === "\\") index++;
            else if (character === "[") inClass = true;
            else if (character === "]") inClass = false;
            else if (character === "/" && !inClass) {
                index++;
                while (/[A-Za-z]/.test(text[index] ?? "")) index++;
                return index;
            }
        }
        return undefined;
    };

    const templateDepths: number[] = [];
    let braceDepth = 0;
    // The last token, which decides whether a slash divides or starts a regular expression.
    let previous = "";
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === "/" && text[index + 1] === "/") {
            let end = index;
            while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
            blank(index, end);
            index = end;
        }
        else if (character === "/" && text[index + 1] === "*") {
            const close = text.indexOf("*/", index + 2);
            const end = close < 0 ? text.length : close + 2;
            blank(index, end);
            index = end;
        }
        else if (character === "'" || character === '"') {
            let end = index + 1;
            while (end < text.length && text[end] !== character && text[end] !== "\n" && text[end] !== "\r") end += text[end] === "\\" ? 2 : 1;
            end = Math.min(end + (text[end] === character ? 1 : 0), text.length);
            blank(index, end);
            index = end;
            previous = "value";
        }
        else if (character === "`") {
            index = scanTemplate(index);
            previous = "value";
        }
        else if (character === "/") {
            const end = regexEnd(index);
            if (end !== undefined && (previous === "" || regexPrecedingKeywords.has(previous) || /^[(,=:[!&|?{;+\-*%<>~^]$/.test(previous))) {
                blank(index, end);
                index = end;
                previous = "value";
            }
            else {
                index++;
                previous = "/";
            }
        }
        else if (/[\w$]/.test(character)) {
            const start = index;
            while (index < text.length && /[\w$]/.test(text[index])) index++;
            previous = text.slice(start, index);
        }
        else {
            if (character === "{") braceDepth++;
            else if (character === "}") {
                if (templateDepths.length && templateDepths[templateDepths.length - 1] === braceDepth) {
                    templateDepths.pop();
                    index = scanTemplate(index);
                    previous = "value";
                    continue;
                }
                braceDepth--;
            }
            if (!/\s/.test(character)) previous = character;
            index++;
        }
    }
    return characters.join("");
}
