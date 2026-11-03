import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
import type { Sort } from "./expression";
import { collectFunctionClauses, parseProperties } from "./contracts";
import type { RefinementModel } from "./refinements";

export interface Clause { readonly value: string; readonly start: number; }
export interface FunctionModel {
    readonly name: string;
    /** The parameters proofs can read, whose arguments `parameterPositions` finds among all `arity` of them. */
    readonly parameters: readonly string[];
    readonly parameterPositions?: readonly number[];
    readonly arity?: number;
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
    type: TS.TypeNode | undefined, refinements: ReadonlyMap<string, RefinementModel>,
): RefinementModel | undefined {
    return type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) ? refinements.get(nameText(type.typeName)) : undefined;
}

export function sortFromType(
    type: TS.TypeNode | undefined,
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
    type: TS.TypeNode | undefined,
    records: ReadonlyMap<string, ReadonlyMap<string, Sort>>,
    numberModel?: FunctionModel["numberModel"],
): ReadonlyMap<string, Sort> | undefined {
    if (!type) return undefined;
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return records.get(nameText(type.typeName));
    if (ts.isParenthesizedTypeNode(type)) return fieldsFromType(type.type, records, numberModel);
    const members = ts.isTypeLiteralNode(type) ? type.members : undefined;
    if (members) {
        const fields = new Map<string, Sort>();
        for (const member of members) {
            if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
            const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? nameText(member.name) : undefined;
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

export function collectRecordTypes(sourceFile: TS.SourceFile): Map<string, ReadonlyMap<string, Sort>> {
    const records = new Map<string, ReadonlyMap<string, Sort>>();
    for (const statement of sourceFile.statements) {
        if (ts.isTypeAliasDeclaration(statement)) {
            const fields = fieldsFromType(statement.type, records);
            if (fields) records.set(nameText(statement.name), fields);
        }
        else if (ts.isInterfaceDeclaration(statement)) {
            const fields = fieldsFromType(ts.factory.createTypeLiteralNode(statement.members), records);
            if (fields) records.set(nameText(statement.name), fields);
        }
    }
    return records;
}

/** A data variant's constructor, as nominal-types describes it. */
export interface DataConstructor {
    readonly tagProperty: string;
    readonly valuesProperty: string;
    readonly tag: string;
    readonly fields: readonly string[];
}

/**
 * Models the `data` declarations of a source file through the nominal-types ADT API. Without nominal-types installed
 * there is no `data` syntax, so there is nothing to model.
 */
export function collectDataTypes(
    nominalTypes: NominalTypesADTAPI | undefined, sourceText: string, records: Map<string, ReadonlyMap<string, Sort>>, sourceFile: TS.SourceFile,
): Map<string, DataConstructor> {
    const aliases = new Map(sourceFile.statements.filter(ts.isTypeAliasDeclaration).map(alias => [nameText(alias.name), sourceFile.text.slice(alias.type.pos, alias.type.end).trim()]));
    /** The type a field wrote, through the file's aliases, whose names the API reports as written. */
    const resolved = (type: string, seen = new Set<string>()): string => {
        const target = aliases.get(type);
        if (target === undefined || seen.has(type)) return type;
        seen.add(type);
        return resolved(target, seen);
    };
    const constructors = new Map<string, DataConstructor>();
    for (const dataType of nominalTypes?.getDataTypes(sourceText) ?? []) {
        const fields = new Map<string, Sort>([[nominalTypes!.tagProperty, "String"]]);
        for (const variant of dataType.variants) {
            for (const field of variant.fields) {
                const type = resolved(field.type);
                const sort = type === "bigint" ? "Int" : type === "number" ? "Real"
                    : type === "boolean" ? "Bool" : type === "string" ? "String" : undefined;
                if (sort) fields.set(field.name, sort);
            }
            constructors.set(variant.name, {
                tagProperty: nominalTypes!.tagProperty,
                valuesProperty: nominalTypes!.valuesProperty,
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
    for (const clause of collectFunctionClauses(sourceText)) {
        const variables: Record<string, Sort> = {};
        const parameters: string[] = [];
        const parameterPattern = /\b([A-Za-z_$][\w$]*)\s*:\s*(boolean|bigint|number)\b/g;
        const parameterText = sourceText.slice(clause.parametersStart + 1, clause.parametersEnd);
        for (let parameter; (parameter = parameterPattern.exec(parameterText));) {
            parameters.push(parameter[1]);
            variables[parameter[1]] = parameter[2] === "boolean" ? "Bool" : "Int";
        }
        const properties = parseProperties(sourceText.slice(clause.open + 1, clause.close), clause.open + 1);
        const numberModelValue = properties.find(item => item.name === "numberModel")?.value.replace(/["']/g, "");
        const numberModel = numberModelValue === "mathematical-real" || numberModelValue === "safe-integer" ? numberModelValue : undefined;
        models.set(clause.name, {
            name: clause.name, parameters, variables,
            requires: properties.filter(item => item.name === "requires"),
            ensures: properties.filter(item => item.name === "ensures"),
            bodyStart: sourceText.indexOf("{", clause.close + 1), numberModel,
        });
    }
    return models;
}

/**
 * Whether a function takes part in verification: it states a contract, a number model, or a refinement, or its body
 * contains a proof directive. Other functions stay callable from verified code but are not checked themselves.
 */
export function participatesInVerification(statement: TS.FunctionDeclaration, model: FunctionModel): boolean {
    if (model.requires.length || model.ensures.length || model.numberModel || model.returnRefinement) return true;
    if (Object.keys(model.parameterRefinements ?? {}).length) return true;
    const hasDirective = (node: TS.Node): boolean =>
        ts.isLabeledStatement(node) && (nameText(node.label) === "assert" || nameText(node.label) === "assume")
        || !ts.isFunctionDeclaration(node) && !!ts.forEachChild(node, hasDirective);
    return !!statement.body && !!ts.forEachChild(statement.body, hasDirective);
}
