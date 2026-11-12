import { maskNonCode } from "@tspp/plugin-sdk";
import type { TSPPFormattingProvider, TSPPTextEdit } from "@tspp/plugin-sdk/language-service";

/** After these, and before the closers and separators, a section has no space; elsewhere one. */
const opensTight = new Set(["(", "[", "."]);
const closesTight = new Set([")", "]", ",", ".", ";"]);

/**
 * Lays out the spaces inside operator sections, which the TypeScript formatter does not see: `( _  +  1 )` becomes
 * `(_ + 1)`. Only spaces between two characters of code on one line change; indentation, line breaks, and the text of
 * comments and literals are left as they are.
 */
export const formatOperatorSections: TSPPFormattingProvider = request => {
    const { sourceText, start, end } = request;
    const code = maskNonCode(sourceText);
    const isCode = (index: number) => code[index] === sourceText[index] && !/\s/.test(sourceText[index] ?? " ");
    const edits: TSPPTextEdit[] = [];
    for (const match of sourceText.slice(start, end).matchAll(/[ \t]+/g)) {
        const runStart = start + match.index;
        const runEnd = runStart + match[0].length;
        if (!isCode(runStart - 1) || !isCode(runEnd)) continue;
        const wanted = opensTight.has(sourceText[runStart - 1]) || closesTight.has(sourceText[runEnd]) ? "" : " ";
        if (match[0] === wanted || !request.isOwned(runStart, runEnd)) continue;
        edits.push({ start: runStart, length: match[0].length, newText: wanted });
    }
    return edits;
};
