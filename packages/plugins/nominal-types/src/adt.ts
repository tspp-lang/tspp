import { dataProperties } from "./representation";
import { maskNonCode } from "@tspp/plugin-sdk";
import type * as TS from "typescript-upstream";
import type { NominalDataField, NominalDataType, NominalDataVariant, NominalTypesADTAPI } from "./api";
import { isMatchEnd } from "./match";

export const nominalTypesADTAPIName = "nominal-types/adt";

/** Splits at commas or bars that are not nested inside brackets, braces, parentheses, or angle brackets. */
function splitTopLevel(text: string, separator: "," | "|"): string[] {
    const parts: string[] = [];
    const code = maskNonCode(text);
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const char = code[index];
        if ("([{<".includes(char)) depth++;
        else if (")]}".includes(char) || char === ">" && text[index - 1] !== "=") depth--;
        else if (char === separator && depth === 0) {
            parts.push(text.slice(start, index));
            start = index + 1;
        }
    }
    parts.push(text.slice(start));
    return parts.map(part => part.trim()).filter(Boolean);
}

function parseFields(text: string): NominalDataField[] {
    return splitTopLevel(text, ",").flatMap(field => {
        const match = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(maskNonCode(field));
        return match ? [{ name: match[1], type: field.slice(match[0].length).trim() }] : [];
    });
}

/** Reads a constructor without confusing nested field types with its signature delimiters. */
export function parseDataVariant(text: string): NominalDataVariant | undefined {
    const code = maskNonCode(text);
    const name = /^\s*([A-Za-z_$][\w$]*)\s*/.exec(code);
    if (!name) return undefined;
    let cursor = name[0].length;
    const balanced = (open: string, close: string): string | undefined => {
        if (code[cursor] !== open) return undefined;
        const start = ++cursor;
        let depth = 1;
        while (cursor < text.length) {
            const char = code[cursor++];
            if (char === open) depth++;
            else if (char === close && !(close === ">" && text[cursor - 2] === "=") && --depth === 0) {
                const result = text.slice(start, cursor - 1);
                while (/\s/.test(code[cursor] ?? "") && cursor < text.length) cursor++;
                return result;
            }
        }
        return undefined;
    };
    const braced = code[cursor] === ":";
    if (braced) {
        cursor++;
        while (/\s/.test(code[cursor] ?? "") && cursor < code.length) cursor++;
    }
    const parameters = balanced("<", ">");
    const fields = balanced("(", ")");
    const rest = text.slice(cursor).trim();
    if (braced) {
        if (fields !== undefined && !rest.startsWith("=>")) return undefined;
        return { name: name[1], fields: parseFields(fields ?? ""), callable: fields !== undefined,
            ...(parameters !== undefined ? { typeParameters: splitTopLevel(parameters, ",") } : {}),
            resultType: fields !== undefined ? rest.slice(2).trim() : rest,
        };
    }
    if (rest && !rest.startsWith(":")) return undefined;
    return { name: name[1], fields: parseFields(fields ?? ""),
        ...(parameters !== undefined ? { typeParameters: splitTopLevel(parameters, ",") } : {}),
        ...(rest ? { resultType: rest.slice(1).trim() } : {}),
    };
}

export interface DataDeclarationSource {
    readonly data: NominalDataType;
    readonly start: number;
    readonly end: number;
    readonly parameterStart: number;
    readonly parameterText: string;
    readonly body: string;
    readonly braced: boolean;
}

/** Source ranges shared by the public ADT description and editor displays. */
export function getDataDeclarationSources(sourceText: string): DataDeclarationSource[] {
    const types: DataDeclarationSource[] = [];
    const header = /\bdata\s+([A-Za-z_$][\w$]*)\s*/g;
    const code = maskNonCode(sourceText);
    for (let match; (match = header.exec(code));) {
        let cursor = header.lastIndex;
        let typeParameters: string[] = [];
        let parameterStart = cursor;
        let parameterText = "";
        if (code[cursor] === "<") {
            // Defaults such as `E = never` may contain `=` and nested angle brackets, so find the matching `>`.
            let depth = 0;
            let close = cursor;
            for (; close < sourceText.length; close++) {
                if (code[close] === "<") depth++;
                else if (code[close] === ">" && code[close - 1] !== "=" && --depth === 0) break;
            }
            parameterStart = cursor + 1;
            parameterText = sourceText.slice(parameterStart, close);
            typeParameters = splitTopLevel(parameterText, ",").map(parameter => parameter.split(/[\s:=]/)[0]);
            cursor = close + 1;
        }
        while (/\s/.test(code[cursor] ?? "") && cursor < code.length) cursor++;
        const braced = code[cursor] === "{";
        if (!braced && code[cursor] !== "=") continue;
        cursor++;
        let end = cursor;
        let depth = 0;
        for (; end < code.length; end++) {
            const char = code[end];
            if (!depth && (braced ? char === "}" : char === ";")) break;
            if ("([{<".includes(char)) depth++;
            else if (")]}".includes(char) || char === ">" && code[end - 1] !== "=") depth--;
        }
        if (end === code.length && braced) break;
        const body = sourceText.slice(cursor, end);
        const variants = splitTopLevel(body, braced ? "," : "|").flatMap(variant => {
            const parsed = parseDataVariant(variant);
            return parsed ? [parsed] : [];
        });
        types.push({ data: { name: match[1], typeParameters, variants }, start: match.index, end: Math.min(end + 1, sourceText.length), parameterStart, parameterText, body, braced });
        header.lastIndex = Math.min(end + 1, code.length);
    }
    return types;
}

function getDataTypes(sourceText: string): NominalDataType[] {
    return getDataDeclarationSources(sourceText).map(source => source.data);
}

/** Describes `data` declarations and their run-time representation, which this plugin owns. */
export const nominalTypesADTAPI: NominalTypesADTAPI = {
    tagProperty: dataProperties.tag,
    valuesProperty: dataProperties.values,
    tagOf: variant => variant.name,
    isMatchEnd: node => isMatchEnd(node as TS.Node),
    getDataTypes,
};
