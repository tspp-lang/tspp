import type { Sort } from "./expression";

function matchingBrace(text: string, open: number): number {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === "{") depth++;
        else if (text[index] === "}" && --depth === 0) return index;
    }
    return -1;
}

export interface RefinementModel {
    readonly name: string;
    readonly sort: Sort;
    readonly predicate: string;
    readonly start: number;
}

export function collectRefinements(sourceText: string): Map<string, RefinementModel> {
    const refinements = new Map<string, RefinementModel>();
    const pattern = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*(bigint|number|boolean)\s+with\s*\{/g;
    for (let match; (match = pattern.exec(sourceText));) {
        const open = sourceText.indexOf("{", match.index);
        const close = matchingBrace(sourceText, open);
        if (close < 0) continue;
        const body = sourceText.slice(open + 1, close);
        const property = /\bpredicate\s*:\s*([^;]+);/.exec(body);
        if (property) {
            const predicate = property[1].trim();
            const start = open + 1 + (property.index ?? 0) + property[0].indexOf(property[1]) + property[1].indexOf(predicate);
            refinements.set(match[1], {
                name: match[1], sort: match[2] === "boolean" ? "Bool" : "Int",
                predicate, start,
            });
        }
        pattern.lastIndex = close + 1;
    }
    return refinements;
}

export function maskRefinementClauses(sourceText: string, characters: string[]): void {
    const pattern = /\btype\s+[A-Za-z_$][\w$]*\s*=\s*(?:bigint|number|boolean)\s+(with\s*\{)/g;
    for (let match; (match = pattern.exec(sourceText));) {
        const start = match.index + match[0].lastIndexOf(match[1]);
        const open = sourceText.indexOf("{", start);
        const close = matchingBrace(sourceText, open);
        if (close < 0) continue;
        for (let index = start; index <= close; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
        pattern.lastIndex = close + 1;
    }
}
