import {
    checkMlttType,
    inferMlttType,
    normalizeMlttTerm,
    type MlttTerm,
} from "./core";
import { parseDependentTypeText } from "./parser";
import { projectMlttTermToTypeScript } from "./projection";

export interface DependentTypeAlias {
    readonly name: string;
    readonly annotation: string;
    readonly annotationLevel?: number;
    readonly annotationStart: number;
    readonly expression: string;
    readonly expressionStart: number;
    readonly expressionEnd: number;
}

const aliasPattern = /\btype\s+([A-Za-z_$][\w$]*)\s*:\s*([^=;]+?)\s*=\s*/g;

export function collectDependentTypeAliases(source: string): DependentTypeAlias[] {
    const aliases: DependentTypeAlias[] = [];
    for (let match; (match = aliasPattern.exec(source));) {
        const rawExpressionStart = aliasPattern.lastIndex;
        const expressionEnd = findStatementEnd(source, rawExpressionStart);
        if (expressionEnd < 0) continue;
        const rawExpression = source.slice(rawExpressionStart, expressionEnd);
        const leadingWhitespace = /^\s*/.exec(rawExpression)![0].length;
        const expressionStart = rawExpressionStart + leadingWhitespace;
        aliases.push({
            name: match[1],
            annotation: match[2].trim(),
            annotationLevel: parseUniverseAnnotation(match[2]),
            annotationStart: match.index + match[0].indexOf(":"),
            expression: source.slice(expressionStart, expressionEnd).trimEnd(),
            expressionStart,
            expressionEnd,
        });
        aliasPattern.lastIndex = expressionEnd + 1;
    }
    return aliases;
}

export function projectDependentTypes(fileName: string, source: string): string {
    if (!fileName.endsWith(".tspp") && !fileName.endsWith(".d.tspp")) return source;
    const characters = [...source];
    const aliases = new Map<string, MlttTerm>();
    for (const alias of collectDependentTypeAliases(source)) {
        const equals = source.lastIndexOf("=", alias.expressionStart);
        for (let index = alias.annotationStart; index < equals; index++) mask(characters, index);
        let replacement = "any";
        try {
            const term = parseDependentType(alias.expression, aliases);
            const projected = projectMlttTermToTypeScript(term);
            if (projected.length <= alias.expressionEnd - alias.expressionStart) replacement = projected;
            aliases.set(alias.name, term);
        }
        catch {
            // The analyzer reports the authored error; keep the upstream parser alive.
        }
        for (let index = alias.expressionStart; index < alias.expressionEnd; index++) mask(characters, index);
        if (!writeIntoMaskedRange(characters, alias.expressionStart, alias.expressionEnd, replacement)) {
            for (let index = alias.expressionStart; index < alias.expressionEnd; index++) mask(characters, index);
            writeIntoMaskedRange(characters, alias.expressionStart, alias.expressionEnd, "any");
        }
    }
    projectPartialInference(source, characters);
    return characters.join("");
}

function projectPartialInference(source: string, characters: string[]): void {
    const partialTypeArguments = /<[^<>\r\n]*\bauto\b[^<>\r\n]*>(?=\s*\()/gu;
    for (let match; (match = partialTypeArguments.exec(source));) {
        for (let index = match.index; index < match.index + match[0].length; index++) mask(characters, index);
    }
}

export function parseDependentType(
    text: string,
    aliases: ReadonlyMap<string, MlttTerm> = new Map(),
): MlttTerm {
    return parseDependentTypeText(text, aliases);
}

export function inferDependentTypeUniverse(term: MlttTerm): number {
    const inferred = normalizeMlttTerm(inferMlttType(term));
    if (inferred.kind !== "universe") {
        throw new Error("The right-hand side is a term, not a type.");
    }
    return inferred.level;
}

export function checkDependentTypeAnnotation(
    term: MlttTerm,
    annotation: string,
    aliases: ReadonlyMap<string, MlttTerm> = new Map(),
): void {
    checkMlttType(term, parseDependentType(annotation, aliases));
}

function parseUniverseAnnotation(annotation: string): number | undefined {
    const match = /^\s*Type(0|[1-9]\d*)?\s*$/u.exec(annotation);
    return match ? (match[1] === undefined ? 0 : Number(match[1])) : undefined;
}

function findStatementEnd(source: string, start: number): number {
    let angle = 0;
    let paren = 0;
    let brace = 0;
    for (let index = start; index < source.length; index++) {
        const char = source[index];
        if (char === "/" && source[index + 1] === "/") {
            const next = source.indexOf("\n", index + 2);
            if (next < 0) return -1;
            index = next;
            continue;
        }
        if (char === "/" && source[index + 1] === "*") {
            const next = source.indexOf("*/", index + 2);
            if (next < 0) return -1;
            index = next + 1;
            continue;
        }
        if (char === "<") angle++;
        else if (char === ">" && source[index - 1] !== "-") angle--;
        else if (char === "(") paren++;
        else if (char === ")") paren--;
        else if (char === "{") brace++;
        else if (char === "}") brace--;
        else if (char === ";" && angle === 0 && paren === 0 && brace === 0) return index;
    }
    return -1;
}

function mask(characters: string[], index: number): void {
    if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
}

function writeIntoMaskedRange(characters: string[], start: number, end: number, replacement: string): boolean {
    const lines: number[][] = [[]];
    for (let index = start; index < end; index++) {
        if (characters[index] === "\n") lines.push([]);
        else if (characters[index] !== "\r") lines[lines.length - 1].push(index);
    }
    const target = lines.find(line => line.length >= replacement.length);
    if (!target) return false;
    for (let index = 0; index < replacement.length; index++) characters[target[index]] = replacement[index];
    return true;
}

