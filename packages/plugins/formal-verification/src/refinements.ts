import { maskNonCode } from "@tspp/plugin-sdk";
import type {
    TSPPPreprocessedTypeAlias,
    TSPPPreprocessedTypeAliasRequest,
} from "@tspp/plugin-sdk/compiler";

import type { Sort } from "./expression";

function matchingBrace(code: string, open: number): number {
    let depth = 0;
    for (let index = open; index < code.length; index++) {
        if (code[index] === "{") depth++;
        else if (code[index] === "}" && --depth === 0) return index;
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
    const code = maskNonCode(sourceText);
    const pattern = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*(bigint|number|boolean)\s+with\s*\{/g;
    for (let match; (match = pattern.exec(code));) {
        const open = code.indexOf("{", match.index);
        const close = matchingBrace(code, open);
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
    const code = maskNonCode(sourceText);
    const pattern = /\btype\s+[A-Za-z_$][\w$]*\s*=\s*(?:bigint|number|boolean)\s+(with\s*\{)/g;
    for (let match; (match = pattern.exec(code));) {
        const start = match.index + match[0].lastIndexOf(match[1]);
        const open = code.indexOf("{", start);
        const close = matchingBrace(code, open);
        if (close < 0) continue;
        for (let index = start; index <= close; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
        pattern.lastIndex = close + 1;
    }
}

export function restoreRefinementTypeAlias(
    request: TSPPPreprocessedTypeAliasRequest,
): TSPPPreprocessedTypeAlias | undefined {
    const code = maskNonCode(request.sourceText);
    const pattern = /\btype\s+([A-Za-z_$][\w$]*)\s*=\s*(bigint|number|boolean)\s+with\s*\{/g;
    const candidates: { readonly start: number; readonly type: string; }[] = [];
    for (let match; (match = pattern.exec(code));) {
        if (match[1] !== request.name) continue;
        const open = code.indexOf("{", match.index);
        const close = matchingBrace(code, open);
        if (close < 0) continue;
        const typeStart = match.index + match[0].indexOf(match[2]);
        candidates.push({ start: match.index, type: request.sourceText.slice(typeStart, close + 1) });
        pattern.lastIndex = close + 1;
    }
    const closest = candidates.reduce<(typeof candidates)[number] | undefined>((current, candidate) =>
        !current
            || Math.abs(candidate.start - request.declarationStart) < Math.abs(current.start - request.declarationStart)
            ? candidate
            : current, undefined);
    return closest && { type: closest.type };
}
