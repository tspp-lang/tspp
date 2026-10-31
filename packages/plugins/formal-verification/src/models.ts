import ts from "typescript";
import type { Sort } from "./expression";
import { matchingBrace, parseProperties } from "./contracts";
import type { RefinementModel } from "./refinements";

export interface Clause { readonly value: string; readonly start: number; }
export interface FunctionModel {
    readonly name: string;
    readonly parameters: readonly string[];
    readonly variables: Readonly<Record<string, Sort>>;
    readonly requires: readonly Clause[];
    readonly ensures: readonly Clause[];
    readonly bodyStart: number;
    readonly parameterRefinements?: Readonly<Record<string, RefinementModel>>;
    readonly returnRefinement?: RefinementModel;
    readonly numberModel?: "mathematical-real" | "safe-integer";
    readonly returnSort?: Sort;
}

export function refinementFromType(
    type: ts.TypeNode | undefined, refinements: ReadonlyMap<string, RefinementModel>,
): RefinementModel | undefined {
    return type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? refinements.get(type.typeName.text) : undefined;
}

export function sortFromType(
    type: ts.TypeNode | undefined,
    refinements: ReadonlyMap<string, RefinementModel> = new Map(),
    numberModel?: FunctionModel["numberModel"],
): Sort | undefined {
    if (!type) return undefined;
    if (type.kind === ts.SyntaxKind.BooleanKeyword) return "Bool";
    if (type.kind === ts.SyntaxKind.StringKeyword) return "String";
    if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) return "String";
    if (type.kind === ts.SyntaxKind.BigIntKeyword) return "Int";
    if (type.kind === ts.SyntaxKind.NumberKeyword) {
        return numberModel === "mathematical-real" ? "Real" : numberModel === "safe-integer" ? "Int" : undefined;
    }
    return refinementFromType(type, refinements)?.sort;
}

export function fieldsFromType(
    type: ts.TypeNode | undefined,
    records: ReadonlyMap<string, ReadonlyMap<string, Sort>>,
    numberModel?: FunctionModel["numberModel"],
): ReadonlyMap<string, Sort> | undefined {
    if (!type) return undefined;
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return records.get(type.typeName.text);
    if (ts.isParenthesizedTypeNode(type)) return fieldsFromType(type.type, records, numberModel);
    const members = ts.isTypeLiteralNode(type) ? type.members : undefined;
    if (members) {
        const fields = new Map<string, Sort>();
        for (const member of members) {
            if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
            const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : undefined;
            const sort = sortFromType(member.type, new Map(), numberModel);
            if (name && sort) fields.set(name, sort);
        }
        return fields;
    }
    if (ts.isUnionTypeNode(type)) {
        const fields = new Map<string, Sort>();
        for (const part of type.types) {
            for (const [name, sort] of fieldsFromType(part, records, numberModel) ?? []) {
                const previous = fields.get(name);
                if (!previous || previous === sort) fields.set(name, sort);
            }
        }
        return fields;
    }
    return undefined;
}

export function collectRecordTypes(sourceFile: ts.SourceFile): Map<string, ReadonlyMap<string, Sort>> {
    const records = new Map<string, ReadonlyMap<string, Sort>>();
    for (const statement of sourceFile.statements) {
        if (ts.isTypeAliasDeclaration(statement)) {
            const fields = fieldsFromType(statement.type, records);
            if (fields) records.set(statement.name.text, fields);
        }
        else if (ts.isInterfaceDeclaration(statement)) {
            const fields = fieldsFromType(ts.factory.createTypeLiteralNode(statement.members), records);
            if (fields) records.set(statement.name.text, fields);
        }
    }
    return records;
}

export function collectDataTypes(
    sourceText: string, records: Map<string, ReadonlyMap<string, Sort>>,
): Map<string, { readonly tag: string; readonly fields: readonly string[]; }> {
    const constructors = new Map<string, { readonly tag: string; readonly fields: readonly string[]; }>();
    const declaration = /\bdata\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]+);/g;
    for (let match; (match = declaration.exec(sourceText));) {
        const fields = new Map<string, Sort>([["_tag", "String"]]);
        for (const variantText of match[2].split("|")) {
            const variant = /^\s*([A-Za-z_$][\w$]*)(?:\s*\((.*)\))?\s*$/.exec(variantText);
            if (!variant) continue;
            const names: string[] = [];
            const fieldPattern = /([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/g;
            for (let field; (field = fieldPattern.exec(variant[2] ?? ""));) {
                names.push(field[1]);
                const sort = field[2] === "bigint" ? "Int" : field[2] === "number" ? "Real"
                    : field[2] === "boolean" ? "Bool" : field[2] === "string" ? "String" : undefined;
                if (sort) fields.set(field[1], sort);
            }
            constructors.set(variant[1], { tag: variant[1], fields: names });
        }
        records.set(match[1], fields);
    }
    return constructors;
}

export function parseFunctionModels(sourceText: string): Map<string, FunctionModel> {
    const models = new Map<string, FunctionModel>();
    const pattern = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*with\s*\{/g;
    for (let match; (match = pattern.exec(sourceText));) {
        const open = sourceText.indexOf("{", match.index + match[0].lastIndexOf("with"));
        const close = matchingBrace(sourceText, open);
        if (close < 0) continue;
        const variables: Record<string, Sort> = {};
        const parameters: string[] = [];
        const parameterPattern = /\b([A-Za-z_$][\w$]*)\s*:\s*(boolean|bigint|number)\b/g;
        for (let parameter; (parameter = parameterPattern.exec(match[2]));) {
            parameters.push(parameter[1]);
            variables[parameter[1]] = parameter[2] === "boolean" ? "Bool" : "Int";
        }
        const properties = parseProperties(sourceText.slice(open + 1, close), open + 1);
        const numberModelValue = properties.find(item => item.name === "numberModel")?.value.replace(/["']/g, "");
        const numberModel = numberModelValue === "mathematical-real" || numberModelValue === "safe-integer" ? numberModelValue : undefined;
        models.set(match[1], {
            name: match[1], parameters, variables,
            requires: properties.filter(item => item.name === "requires"),
            ensures: properties.filter(item => item.name === "ensures"),
            bodyStart: sourceText.indexOf("{", close + 1), numberModel,
        });
        pattern.lastIndex = close + 1;
    }
    return models;
}
