import type { TSPPPreprocessedFunctionRequest } from "@tspp/plugin-sdk/compiler";

import type { Z3Query } from "./solver";
import { maskRefinementClauses } from "./refinements";

export interface PendingProof {
    readonly query: Z3Query;
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly name: string;
}

export function matchingBrace(text: string, open: number): number {
    let depth = 0;
    let quote = "";
    for (let index = open; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === "\\") index++;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
        if (char === "/" && text[index + 1] === "/") { index = text.indexOf("\n", index); if (index < 0) return -1; continue; }
        if (char === "/" && text[index + 1] === "*") { index = text.indexOf("*/", index + 2); if (index < 0) return -1; index++; continue; }
        if (char === "{") depth++;
        else if (char === "}" && --depth === 0) return index;
    }
    return -1;
}

function matchingParenthesis(text: string, open: number): number {
    let depth = 0;
    let quote = "";
    for (let index = open; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (char === "\\") index++;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
        if (char === "/" && text[index + 1] === "/") { index = text.indexOf("\n", index); if (index < 0) return -1; continue; }
        if (char === "/" && text[index + 1] === "*") { index = text.indexOf("*/", index + 2); if (index < 0) return -1; index++; continue; }
        if (char === "(") depth++;
        else if (char === ")" && --depth === 0) return index;
    }
    return -1;
}

export function restoreContractFunctionWithClause(request: TSPPPreprocessedFunctionRequest): string | undefined {
    if (!request.fileName.endsWith(".tspp")) return undefined;
    const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
    const candidates: { readonly start: number; readonly clause: string; }[] = [];
    for (let match; (match = pattern.exec(request.sourceText));) {
        if (match[1] !== request.name) continue;
        const openParenthesis = request.sourceText.indexOf("(", match.index);
        const closeParenthesis = matchingParenthesis(request.sourceText, openParenthesis);
        if (closeParenthesis < 0) continue;
        let clauseStart = closeParenthesis + 1;
        while (/\s/.test(request.sourceText[clauseStart] ?? "")) clauseStart++;
        if (!request.sourceText.startsWith("with", clauseStart)) continue;
        const openBrace = request.sourceText.indexOf("{", clauseStart + 4);
        const closeBrace = matchingBrace(request.sourceText, openBrace);
        if (openBrace < 0 || closeBrace < 0) continue;
        candidates.push({ start: match.index, clause: request.sourceText.slice(clauseStart, closeBrace + 1) });
        pattern.lastIndex = closeBrace + 1;
    }
    return candidates.reduce<(typeof candidates)[number] | undefined>((closest, candidate) =>
        !closest
            || Math.abs(candidate.start - request.declarationStart) < Math.abs(closest.start - request.declarationStart)
            ? candidate
            : closest, undefined)?.clause;
}

export function maskContractClauses(fileName: string, sourceText: string, maskDirectives = true): string {
    if (!fileName.endsWith(".tspp")) return sourceText;
    const characters = [...sourceText];
    maskRefinementClauses(sourceText, characters);
    const pattern = /\bwith\s*\{/g;
    for (let match; (match = pattern.exec(sourceText));) {
        let previous = match.index - 1;
        while (previous >= 0 && /\s/.test(sourceText[previous])) previous--;
        if (sourceText[previous] !== ")") continue;
        const prefix = sourceText.slice(Math.max(0, match.index - 500), match.index);
        if (!/\b(function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)|while\s*\([^)]*\))\s*$/.test(prefix)) continue;
        const open = sourceText.indexOf("{", match.index);
        const close = matchingBrace(sourceText, open);
        if (close < 0) continue;
        for (let index = match.index; index <= close; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
        pattern.lastIndex = close + 1;
    }
    if (maskDirectives) {
        const directivePattern = /\b(?:assert|assume)\s*:\s*[^;]+;/g;
        for (let match; (match = directivePattern.exec(sourceText));) {
            for (let index = match.index; index < match.index + match[0].length; index++) {
                if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
            }
        }
    }
    return characters.join("");
}

export function splitClauseExpressions(value: string): string[] {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [trimmed];
    const body = trimmed.slice(1, -1);
    const values: string[] = [];
    let start = 0;
    let depth = 0;
    let quote = "";
    for (let index = 0; index <= body.length; index++) {
        const char = body[index] ?? ",";
        if (quote) {
            if (char === "\\") index++;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'" || char === "`") quote = char;
        else if ("([{".includes(char)) depth++;
        else if (")]}".includes(char)) depth--;
        else if (char === "," && depth === 0) {
            const item = body.slice(start, index).trim();
            if (item) values.push(item);
            start = index + 1;
        }
    }
    return values;
}

export function parseProperties(text: string, absoluteStart: number): { name: string; value: string; start: number; }[] {
    const properties: { name: string; value: string; start: number; }[] = [];
    const pattern = /\b(requires|ensures|invariant|predicate|numberModel)\s*:\s*([^;]+);/g;
    for (let match; (match = pattern.exec(text));) {
        const raw = match[2].trim();
        const base = absoluteStart + match.index + match[0].indexOf(match[2]);
        for (const value of splitClauseExpressions(raw)) {
            properties.push({ name: match[1], value, start: base + raw.indexOf(value) });
        }
    }
    return properties;
}
