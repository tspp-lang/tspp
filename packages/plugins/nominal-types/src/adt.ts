import { maskNonCode } from "@tspp/plugin-sdk";
import type * as TS from "typescript-upstream";
import type { NominalDataField, NominalDataType, NominalTypesADTAPI } from "./api";
import { isMatchEnd } from "./match";

export const nominalTypesADTAPIName = "nominal-types/adt";

/** Splits at commas or bars that are not nested inside brackets, braces, parentheses, or angle brackets. */
function splitTopLevel(text: string, separator: "," | "|"): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
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
        const match = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(field);
        return match ? [{ name: match[1], type: match[2].trim() }] : [];
    });
}

function getDataTypes(sourceText: string): NominalDataType[] {
    const types: NominalDataType[] = [];
    const header = /\bdata\s+([A-Za-z_$][\w$]*)\s*/g;
    const code = maskNonCode(sourceText);
    for (let match; (match = header.exec(code));) {
        let cursor = header.lastIndex;
        let typeParameters: string[] = [];
        if (sourceText[cursor] === "<") {
            // Defaults such as `E = never` may contain `=` and nested angle brackets, so find the matching `>`.
            let depth = 0;
            let close = cursor;
            for (; close < sourceText.length; close++) {
                if (sourceText[close] === "<") depth++;
                else if (sourceText[close] === ">" && sourceText[close - 1] !== "=" && --depth === 0) break;
            }
            typeParameters = splitTopLevel(sourceText.slice(cursor + 1, close), ",").map(parameter => parameter.split(/[\s:=]/)[0]);
            cursor = close + 1;
        }
        const equals = /^\s*=/.exec(sourceText.slice(cursor));
        if (!equals) continue;
        cursor += equals[0].length;
        const end = code.indexOf(";", cursor);
        if (end < 0) break;
        const variants = splitTopLevel(sourceText.slice(cursor, end), "|").flatMap(variant => {
            const parsed = /^([A-Za-z_$][\w$]*)\s*(?:\(([\s\S]*)\))?$/.exec(variant);
            return parsed ? [{ name: parsed[1], fields: parseFields(parsed[2] ?? "") }] : [];
        });
        types.push({ name: match[1], typeParameters, variants });
        header.lastIndex = end + 1;
    }
    return types;
}

/** Describes `data` declarations and their run-time representation, which this plugin owns. */
export const nominalTypesADTAPI: NominalTypesADTAPI = {
    tagProperty: "_tag",
    valuesProperty: "_values",
    tagOf: variant => variant.name,
    isMatchEnd: node => isMatchEnd(node as TS.Node),
    getDataTypes,
};
