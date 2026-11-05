import { maskNonCode } from "@tspp/plugin-sdk";

/** A computed alias keeps its authored kind annotations, expands `match`, and substitutes type-level `let` bindings. */
export function computedAliasDisplay(name: string, sourceText: string): string | undefined {
    const code = maskNonCode(sourceText);
    const declaration = new RegExp(`\\btype\\s+${escapeRegExp(name)}\\b`, "g").exec(code);
    if (!declaration) return undefined;
    const equals = findTopLevel(code, declaration.index + declaration[0].length, index => code[index] === "=" && code[index + 1] !== ">");
    if (equals < 0) return undefined;
    const end = findTopLevel(code, equals + 1, index => code[index] === ";");
    const expressionEnd = end < 0 ? sourceText.length : end;
    const expression = sourceText.slice(equals + 1, expressionEnd).trim();
    if (!/^(?:match|let)\b/.test(maskNonCode(expression).trimStart())) return undefined;
    const header = normalizeSource(sourceText.slice(declaration.index, equals));
    return `${header} = ${renderComputedType(expression, new Map())}`;
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

function renderComputedType(source: string, bindings: ReadonlyMap<string, string>): string {
    const text = source.trim();
    const code = maskNonCode(text);
    if (/^let\b/.test(code)) return renderLet(text, code, bindings);
    if (/^match\b/.test(code)) return renderMatch(text, code, bindings);
    return substituteBindings(text, bindings);
}

function renderLet(source: string, code: string, bindings: ReadonlyMap<string, string>): string {
    const binding = /^let\s+([A-Za-z_$][\w$]*)\s*=/.exec(code);
    if (!binding) return substituteBindings(source, bindings);
    const valueStart = binding[0].length;
    const inStart = findTopLevelWord(code, valueStart, "in");
    if (inStart < 0) return substituteBindings(source, bindings);
    const value = renderComputedType(source.slice(valueStart, inStart), bindings);
    const nested = new Map(bindings);
    nested.set(binding[1], bindingReplacement(value));
    return renderComputedType(source.slice(inStart + 2), nested);
}

function bindingReplacement(value: string): string {
    const code = maskNonCode(value);
    const hasLooseOperator = findTopLevel(code, 0, index => ["|", "&", "?"].includes(code[index])
        || code[index] === "=" && code[index + 1] === ">") >= 0;
    return hasLooseOperator ? `(${value})` : value;
}

function renderMatch(source: string, code: string, bindings: ReadonlyMap<string, string>): string {
    const bodyOpen = findMatchBody(code);
    if (bodyOpen < 0) return substituteBindings(source, bindings);
    const bodyClose = matchingClose(code, bodyOpen);
    if (bodyClose < 0) return substituteBindings(source, bindings);
    const scrutinee = substituteBindings(source.slice("match".length, bodyOpen), bindings);
    const arms = splitTopLevel(source.slice(bodyOpen + 1, bodyClose), [",", ";"]);
    const rendered: { readonly pattern: string; readonly result: string; readonly fallback: boolean; }[] = [];
    for (const arm of arms) {
        const armCode = maskNonCode(arm);
        const separator = findTopLevel(armCode, 0, index => armCode[index] === ":");
        if (separator < 0) continue;
        const patternSource = arm.slice(0, separator).trim();
        const armBindings = new Map(bindings);
        for (const capture of maskNonCode(patternSource).matchAll(/\binfer\s+([A-Za-z_$][\w$]*)/g)) armBindings.delete(capture[1]);
        const pattern = substituteBindings(patternSource, armBindings);
        const catchAll = /^(?:_|infer\s+([A-Za-z_$][\w$]*))$/.exec(pattern);
        if (catchAll?.[1]) armBindings.set(catchAll[1], scrutinee);
        rendered.push({
            pattern,
            result: renderComputedType(arm.slice(separator + 1), armBindings),
            fallback: !!catchAll,
        });
        if (catchAll) break;
    }
    let result = "never";
    for (let index = rendered.length - 1; index >= 0; index--) {
        const arm = rendered[index];
        result = arm.fallback ? arm.result : `[${scrutinee}] extends [${arm.pattern}] ? ${arm.result} : ${result}`;
    }
    return result;
}

function findTopLevelWord(text: string, start: number, word: string): number {
    return findTopLevel(text, start, index => text.slice(index, index + word.length) === word
        && !/[\w$]/.test(text[index - 1] ?? "") && !/[\w$]/.test(text[index + word.length] ?? ""));
}

/** The match body is the top-level brace whose close ends the expression, not an object type used as its scrutinee. */
function findMatchBody(code: string): number {
    for (let index = "match".length; index < code.length; index++) {
        if (code[index] !== "{") continue;
        const close = matchingClose(code, index);
        if (close >= 0 && !code.slice(close + 1).trim()) return index;
    }
    return -1;
}

function matchingClose(text: string, open: number): number {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === "{") depth++;
        else if (text[index] === "}" && --depth === 0) return index;
    }
    return -1;
}

function splitTopLevel(source: string, separators: readonly string[]): string[] {
    const code = maskNonCode(source);
    const parts: string[] = [];
    let start = 0;
    while (start < source.length) {
        const end = findTopLevel(code, start, index => separators.includes(code[index]));
        parts.push(source.slice(start, end < 0 ? source.length : end));
        if (end < 0) break;
        start = end + 1;
    }
    return parts.filter(part => part.trim());
}

function substituteBindings(source: string, bindings: ReadonlyMap<string, string>): string {
    const code = maskNonCode(source);
    let result = "";
    let position = 0;
    for (const match of code.matchAll(/[A-Za-z_$][\w$]*/g)) {
        result += source.slice(position, match.index) + (bindings.get(match[0]) ?? source.slice(match.index, match.index + match[0].length));
        position = match.index + match[0].length;
    }
    return normalizeSource(result + source.slice(position));
}

function normalizeSource(source: string): string {
    return source.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
