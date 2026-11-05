import { maskNonCode } from "@tspp/plugin-sdk";
import type { TSPPAnalysisDiagnostic, TSPPPreprocessedFunctionRequest, TSPPSyntaxExtension, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";

import type { Z3Query } from "./solver";

export interface PendingProof {
    readonly query: Z3Query;
    readonly fileName: string;
    readonly start: number;
    readonly length: number;
    readonly name: string;
}

let keepingDirectives = false;

/** Runs `parse` so that proof directives stay the labeled statements the verifier reads, instead of being erased. */
export function keepingProofDirectives<T>(parse: () => T): T {
    keepingDirectives = true;
    try {
        return parse();
    }
    finally {
        keepingDirectives = false;
    }
}

const directiveKeywords = ["assert", "assume"];

/** `assert: condition;` and `assume: condition;` at the start of a statement. They run only in the verifier, so a program has none. */
export function createProofDirectives(ts: TSPPTypeScript): TSPPSyntaxExtension {
    const kinds = ts.SyntaxKind;
    return {
        position: "statement",
        // `assert` is a contextual keyword of TypeScript's, with a token of its own.
        startTokens: [kinds.Identifier, kinds.AssertKeyword],
        keywords: directiveKeywords,
        isStart: cursor => !keepingDirectives && directiveKeywords.includes(cursor.tokenText()) && cursor.lookAhead(() => cursor.nextToken() === kinds.ColonToken),
        parse(cursor) {
            const pos = cursor.getNodePos();
            cursor.nextToken();
            cursor.nextToken();
            const condition = cursor.parseExpression();
            cursor.parseSemicolon();
            return cursor.finishNode(cursor.factory.createNotEmittedStatement(condition), pos);
        },
    };
}

export function matchingBrace(text: string, open: number): number {
    return matchingClose(maskNonCode(text), open, "{", "}");
}

/** The closing bracket of the one at `open`, in text whose strings and comments are blank. */
function matchingClose(code: string, open: number, opening: string, closing: string): number {
    let depth = 0;
    for (let index = open; index < code.length; index++) {
        if (code[index] === opening) depth++;
        else if (code[index] === closing && --depth === 0) return index;
    }
    return -1;
}

function matchingOpen(code: string, close: number, opening: string, closing: string): number {
    let depth = 0;
    for (let index = close; index >= 0; index--) {
        if (code[index] === closing) depth++;
        else if (code[index] === opening && --depth === 0) return index;
    }
    return -1;
}

function previousToken(code: string, end: number): number {
    let index = end - 1;
    while (index >= 0 && /\s/.test(code[index])) index--;
    return index;
}

export interface FunctionClause {
    readonly name: string;
    readonly start: number;
    readonly parametersStart: number;
    readonly parametersEnd: number;
    readonly clauseStart: number;
    readonly open: number;
    readonly close: number;
}

/** The token before another plugin's `word <...>` clause ending at `close`, which may stand between parameters and `with`. */
function beforeFunctionClause(code: string, close: number): number {
    let depth = 0;
    for (let index = close; index >= 0; index--) {
        if (code[index] === ">" && code[index - 1] !== "=") depth++;
        else if (code[index] === "<" && --depth === 0) {
            const word = previousToken(code, index);
            let start = word;
            while (start > 0 && /[\w$]/.test(code[start - 1])) start--;
            return /[\w$]/.test(code[word]) ? previousToken(code, start) : close;
        }
    }
    return close;
}

/**
 * The `with` clause a declaration's `function name<...>(...)` is followed by, for the clause at `withStart`: the
 * parameters are matched as brackets, so type parameters and function types in them need no special case.
 */
function functionOfClause(code: string, withStart: number): Omit<FunctionClause, "clauseStart" | "open" | "close"> | undefined {
    let parametersEnd = previousToken(code, withStart);
    if (code[parametersEnd] === ">") parametersEnd = beforeFunctionClause(code, parametersEnd);
    if (code[parametersEnd] !== ")") return undefined;
    const parametersStart = matchingOpen(code, parametersEnd, "(", ")");
    if (parametersStart < 0) return undefined;
    let beforeParameters = previousToken(code, parametersStart);
    if (code[beforeParameters] === ">") {
        // `=>` inside the type parameters is not a closing bracket.
        let depth = 0;
        let index = beforeParameters;
        for (; index >= 0; index--) {
            if (code[index] === ">" && code[index - 1] !== "=") depth++;
            else if (code[index] === "<" && --depth === 0) break;
        }
        if (index < 0) return undefined;
        beforeParameters = previousToken(code, index);
    }
    const header = /\bfunction\s+([A-Za-z_$][\w$]*)$/.exec(code.slice(Math.max(0, beforeParameters - 200), beforeParameters + 1));
    return header ? { name: header[1], start: beforeParameters - header[0].length + 1, parametersStart, parametersEnd } : undefined;
}

/** Every function declaration's `with` clause in the text of a file. */
export function collectFunctionClauses(sourceText: string): FunctionClause[] {
    const code = maskNonCode(sourceText);
    const clauses: FunctionClause[] = [];
    const pattern = /\bwith\s*\{/g;
    for (let match; (match = pattern.exec(code));) {
        const owner = functionOfClause(code, match.index);
        if (!owner) continue;
        const open = code.indexOf("{", match.index);
        const close = matchingClose(code, open, "{", "}");
        if (close < 0) continue;
        clauses.push({ ...owner, clauseStart: match.index, open, close });
        pattern.lastIndex = close + 1;
    }
    return clauses;
}

export function restoreContractFunctionClause(request: TSPPPreprocessedFunctionRequest): string | undefined {
    const candidates = collectFunctionClauses(request.sourceText).filter(clause => clause.name === request.name);
    const closest = candidates.reduce<FunctionClause | undefined>((current, candidate) =>
        !current
            || Math.abs(candidate.start - request.declarationStart) < Math.abs(current.start - request.declarationStart)
            ? candidate
            : current, undefined);
    return closest && request.sourceText.slice(closest.clauseStart, closest.close + 1);
}

export function maskContractClauses(_fileName: string, sourceText: string): string {
    const code = maskNonCode(sourceText);
    const characters = sourceText.split("");
    const blank = (start: number, end: number) => {
        for (let index = start; index < end; index++) {
            if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
        }
    };
    for (const clause of collectFunctionClauses(sourceText)) blank(clause.clauseStart, clause.close + 1);
    const loopPattern = /\bwith\s*\{/g;
    for (let match; (match = loopPattern.exec(code));) {
        const parametersEnd = previousToken(code, match.index);
        if (code[parametersEnd] !== ")") continue;
        const parametersStart = matchingOpen(code, parametersEnd, "(", ")");
        if (parametersStart < 0 || !/\bwhile\s*$/.test(code.slice(Math.max(0, parametersStart - 20), parametersStart))) continue;
        const open = code.indexOf("{", match.index);
        const close = matchingClose(code, open, "{", "}");
        if (close < 0) continue;
        blank(match.index, close + 1);
        loopPattern.lastIndex = close + 1;
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

const loopProperties = ["invariant"];
const functionProperties = ["requires", "ensures", "numberModel"];
const refinementProperties = ["predicate", "numberModel"];

/**
 * Reports repeated and unrecognized properties in contract `with` clauses. Both would otherwise be dropped or merged
 * silently, and a misspelled `ensures` would leave the function without the postcondition its author wrote.
 */
export function reportWithClauseIssues(fileName: string, sourceText: string, diagnostics: TSPPAnalysisDiagnostic[]): void {
    const report = (start: number, length: number, message: string) => diagnostics.push({
        fileName, start, length, code: 19005, category: "error", source: "TS++ verification", message,
    });
    const code = maskNonCode(sourceText);
    const pattern = /\bwith\s*\{/g;
    for (let match; (match = pattern.exec(code));) {
        const end = previousToken(code, match.index);
        const owner = functionOfClause(code, match.index) ? { owner: "a function", properties: functionProperties }
            : code[end] === ")" && /\bwhile\s*$/.test(code.slice(Math.max(0, matchingOpen(code, end, "(", ")") - 20), Math.max(0, matchingOpen(code, end, "(", ")")))) ? { owner: "a loop", properties: loopProperties }
            : /\b(?:bigint|number|boolean)\s+$/.test(code.slice(Math.max(0, match.index - 20), match.index)) ? { owner: "a refinement type", properties: refinementProperties }
            : undefined;
        if (!owner) continue;
        const open = code.indexOf("{", match.index);
        const close = matchingClose(code, open, "{", "}");
        if (close < 0) continue;
        const seen = new Set<string>();
        for (const entry of topLevelEntries(sourceText, open + 1, close)) {
            const key = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(entry.text);
            if (!key) continue;
            const name = key[1];
            const start = entry.start + key[0].indexOf(name);
            if (!owner.properties.includes(name)) {
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
