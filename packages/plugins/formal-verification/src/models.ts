import ts from "typescript";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
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

/** A data variant's constructor, as nominal-types describes it. */
export interface DataConstructor {
    readonly tagProperty: string;
    readonly tag: string;
    readonly fields: readonly string[];
}

/**
 * Models the `data` declarations of a source file through the nominal-types ADT API. Without nominal-types installed
 * there is no `data` syntax, so there is nothing to model.
 */
export function collectDataTypes(
    nominalTypes: NominalTypesADTAPI | undefined, sourceText: string, records: Map<string, ReadonlyMap<string, Sort>>,
): Map<string, DataConstructor> {
    const constructors = new Map<string, DataConstructor>();
    for (const dataType of nominalTypes?.getDataTypes(sourceText) ?? []) {
        const fields = new Map<string, Sort>([[nominalTypes!.tagProperty, "String"]]);
        for (const variant of dataType.variants) {
            for (const field of variant.fields) {
                const sort = field.type === "bigint" ? "Int" : field.type === "number" ? "Real"
                    : field.type === "boolean" ? "Bool" : field.type === "string" ? "String" : undefined;
                if (sort) fields.set(field.name, sort);
            }
            constructors.set(variant.name, {
                tagProperty: nominalTypes!.tagProperty,
                tag: nominalTypes!.tagOf(variant),
                fields: variant.fields.map(field => field.name),
            });
        }
        records.set(dataType.name, fields);
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

/**
 * Whether a function takes part in verification: it states a contract, a number model, or a refinement, or its body
 * contains a proof directive. Other functions stay callable from verified code but are not checked themselves.
 */
export function participatesInVerification(statement: ts.FunctionDeclaration, model: FunctionModel): boolean {
    if (model.requires.length || model.ensures.length || model.numberModel || model.returnRefinement) return true;
    if (Object.keys(model.parameterRefinements ?? {}).length) return true;
    const hasDirective = (node: ts.Node): boolean =>
        ts.isLabeledStatement(node) && (node.label.text === "assert" || node.label.text === "assume")
        || !ts.isFunctionLike(node) && !!ts.forEachChild(node, hasDirective);
    return !!statement.body && !!ts.forEachChild(statement.body, hasDirective);
}
