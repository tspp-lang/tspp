import type { TSPPAnalysisDiagnostic, TSPPPreprocessedFunctionRequest } from "@tspp/plugin-sdk/compiler";

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

/**
 * Macro functions keep their `with` clause for the compiler, which checks and applies it. Temporary: the macros
 * plugin moves its configuration into `macro(...)` (docs/core-restoration-plan.md), after which `with` belongs to
 * contracts alone and this check goes away.
 */
function isMacroWithClause(prefix: string): boolean {
    return /\bmacro\s+function\b[^{]*$/.test(prefix);
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
        if (isMacroWithClause(prefix)) continue;
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

const withClauseOwners = [
    { pattern: /\bwhile\s*\([^)]*\)\s*$/, owner: "a loop", properties: ["invariant"] },
    { pattern: /\bfunction\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*$/, owner: "a function", properties: ["requires", "ensures", "numberModel"] },
    { pattern: /\btype\s+[A-Za-z_$][\w$]*\s*=\s*(?:bigint|number|boolean)\s+$/, owner: "a refinement type", properties: ["predicate", "numberModel"] },
] as const;

/**
 * Reports repeated and unrecognized properties in contract `with` clauses. Both would otherwise be dropped or merged
 * silently, and a misspelled `ensures` would leave the function without the postcondition its author wrote.
 */
export function reportWithClauseIssues(fileName: string, sourceText: string, diagnostics: TSPPAnalysisDiagnostic[]): void {
    if (!fileName.endsWith(".tspp")) return;
    const report = (start: number, length: number, message: string) => diagnostics.push({
        fileName, start, length, code: 19005, category: "error", source: "TS++ verification", message,
    });
    const pattern = /\bwith\s*\{/g;
    for (let match; (match = pattern.exec(sourceText));) {
        const prefix = sourceText.slice(Math.max(0, match.index - 500), match.index);
        const owner = isMacroWithClause(prefix)
            ? undefined
            : withClauseOwners.find(candidate => candidate.pattern.test(prefix));
        if (!owner) continue;
        const open = sourceText.indexOf("{", match.index);
        const close = matchingBrace(sourceText, open);
        if (close < 0) continue;
        const seen = new Set<string>();
        for (const entry of topLevelEntries(sourceText, open + 1, close)) {
            const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(entry.text);
            if (!key) continue;
            const name = key[1];
            const start = entry.start + key[0].indexOf(name);
            if (!(owner.properties as readonly string[]).includes(name)) {
                report(start, name.length, `The 'with' property '${name}' is not supported on ${owner.owner}.`);
            }
            else if (seen.has(name)) {
                report(start, name.length, `The 'with' property '${name}' may only be specified once.`);
            }
            seen.add(name);
        }
        pattern.lastIndex = close + 1;
    }
}

function topLevelEntries(text: string, start: number, end: number): { text: string; start: number; }[] {
    const entries: { text: string; start: number; }[] = [];
    let depth = 0;
    let quote = "";
    let entryStart = start;
    for (let index = start; index <= end; index++) {
        const char = index === end ? ";" : text[index];
        if (quote) {
            if (char === "\\") index++;
            else if (char === quote) quote = "";
            continue;
        }
        if (char === '"' || char === "'" || char === "`") quote = char;
        else if ("([{".includes(char)) depth++;
        else if (")]}".includes(char)) depth--;
        else if (char === ";" && depth === 0) {
            entries.push({ text: text.slice(entryStart, index), start: entryStart });
            entryStart = index + 1;
        }
    }
    return entries;
}
