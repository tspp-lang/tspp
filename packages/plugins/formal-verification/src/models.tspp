import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
import { identifierSource, type Sort } from "./expression";
import { collectFunctionClauses, parseProperties } from "./contracts";
import { refinedTypeEnd, type RefinementModel } from "./refinements";

export interface Clause { readonly value: string; readonly start: number; }
export type RecordFields = ReadonlyMap<string, Sort | undefined>;
export const numberSortFromModel = (model: FunctionModel["numberModel"]) =>
    model === "mathematical-real" ? "Real" : model === "safe-integer" ? "NumberInt" : undefined;
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

/** The contract written in a `with` clause, before the signature it belongs to is known. */
export interface ContractClause {
    readonly requires: readonly Clause[];
    readonly ensures: readonly Clause[];
    readonly numberModel?: FunctionModel["numberModel"];
}

/** Whether a call to the function owes a proof: it has a precondition or a refined parameter. */
export function guardsCalls(model: FunctionModel): boolean {
    return model.requires.length > 0 || Object.keys(model.parameterRefinements ?? {}).length > 0;
}

/**
 * Models a function-like declaration's signature: the parameters proofs can read, the fields of record parameters, and
 * refinements. Parameters of other types are left out, though calls still pass every argument.
 */
export function modelSignature(
    name: string,
    declaration: TS.SignatureDeclaration,
    contract: ContractClause | undefined,
    refinements: ReadonlyMap<string, RefinementModel>,
    records: ReadonlyMap<string, RecordFields>,
    bodyStart: number,
): FunctionModel {
    const numberModel = contract?.numberModel;
    const variables: Record<string, Sort> = {};
    const parameters: string[] = [];
    const parameterPositions: number[] = [];
    const parameterRefinements: Record<string, RefinementModel> = {};
    for (const [position, parameter] of declaration.parameters.entries()) {
        if (!ts.isIdentifier(parameter.name)) continue;
        const refinement = refinementFromType(parameter.type, refinements);
        const sort = refinement?.sort ?? sortFromType(parameter.type, refinements, numberModel);
        if (sort) {
            parameters.push(nameText(parameter.name));
            parameterPositions.push(position);
            variables[nameText(parameter.name)] = sort;
            if (refinement) parameterRefinements[nameText(parameter.name)] = refinement;
        }
        else {
            for (const [field, typeSort] of fieldsFromType(parameter.type, records) ?? []) {
                const sort = typeSort === "NumberInt" ? numberSortFromModel(numberModel) : typeSort;
                if (sort) variables[`${nameText(parameter.name)}.${field}`] = sort;
            }
        }
    }
    const returnRefinement = refinementFromType(declaration.type, refinements);
    return {
        name, parameters, parameterPositions, arity: declaration.parameters.length, variables,
        requires: contract?.requires ?? [], ensures: contract?.ensures ?? [],
        bodyStart, parameterRefinements, returnRefinement, numberModel,
        returnSort: returnRefinement?.sort ?? sortFromType(declaration.type, refinements, numberModel),
    };
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
        return numberSortFromModel(numberModel);
    }
    return refinementFromType(type, refinements)?.sort;
}

function mergeField(fields: Map<string, Sort | undefined>, name: string, sort: Sort | undefined): void {
    // Keep an ambiguous field in the map so a later variant cannot give it a type again.
    fields.set(name, fields.has(name) && fields.get(name) !== sort ? undefined : sort);
}

function fieldsFromType(type: TS.TypeNode | undefined, records: ReadonlyMap<string, RecordFields>): RecordFields | undefined {
    if (!type) return undefined;
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) return records.get(nameText(type.typeName));
    if (ts.isParenthesizedTypeNode(type)) return fieldsFromType(type.type, records);
    const members = ts.isTypeLiteralNode(type) ? type.members : undefined;
    if (members) {
        const fields = new Map<string, Sort | undefined>();
        for (const member of members) {
            if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
            const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? nameText(member.name) : undefined;
            if (name) fields.set(name, sortFromType(member.type, undefined, "safe-integer"));
        }
        return fields;
    }
    if (ts.isUnionTypeNode(type)) {
        const fields = new Map<string, Sort | undefined>();
        for (const part of type.types) {
            for (const [name, sort] of fieldsFromType(part, records) ?? []) mergeField(fields, name, sort);
        }
        return fields;
    }
    return undefined;
}

export function collectRecordTypes(sourceFile: TS.SourceFile): Map<string, RecordFields> {
    const records = new Map<string, RecordFields>();
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
    nominalTypes: NominalTypesADTAPI | undefined, sourceText: string, records: Map<string, RecordFields>, sourceFile: TS.SourceFile,
): Map<string, DataConstructor> {
    const aliases = new Map(sourceFile.statements.filter(ts.isTypeAliasDeclaration).map(alias => [nameText(alias.name), sourceFile.text.slice(alias.type.pos, refinedTypeEnd(alias.type)).trim()]));
    /** The type a field wrote, through the file's aliases, whose names the API reports as written. */
    const resolved = (type: string, seen = new Set<string>()): string => {
        const target = aliases.get(type);
        if (target === undefined || seen.has(type)) return type;
        seen.add(type);
        return resolved(target, seen);
    };
    const constructors = new Map<string, DataConstructor>();
    for (const dataType of nominalTypes?.getDataTypes(sourceText) ?? []) {
        const fields = new Map<string, Sort | undefined>([[nominalTypes!.tagProperty, "String"]]);
        for (const variant of dataType.variants) {
            for (const field of variant.fields) {
                const type = resolved(field.type);
                const sort = type === "bigint" ? "Int" : type === "number" ? "NumberInt"
                    : type === "boolean" ? "Bool" : type === "string" ? "String" : undefined;
                mergeField(fields, field.name, sort);
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
        const properties = parseProperties(sourceText.slice(clause.open + 1, clause.close), clause.open + 1);
        const numberModelValue = properties.find(item => item.name === "numberModel")?.value.replace(/["']/g, "");
        const numberModel = numberModelValue === "mathematical-real" || numberModelValue === "safe-integer" ? numberModelValue : undefined;
        const variables: Record<string, Sort> = {};
        const parameters: string[] = [];
        const parameterPattern = new RegExp(String.raw`(${identifierSource})\s*:\s*(boolean|bigint|number)\b`, "gu");
        const parameterText = sourceText.slice(clause.parametersStart + 1, clause.parametersEnd);
        for (let parameter; (parameter = parameterPattern.exec(parameterText));) {
            parameters.push(parameter[1]);
            variables[parameter[1]] = parameter[2] === "boolean" ? "Bool" : parameter[2] === "bigint" ? "Int"
                : numberModel === "mathematical-real" ? "Real" : "NumberInt";
        }
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
export function participatesInVerification(statement: TS.FunctionLikeDeclaration, model: FunctionModel): boolean {
    if (model.requires.length || model.ensures.length || model.numberModel || model.returnRefinement) return true;
    if (Object.keys(model.parameterRefinements ?? {}).length) return true;
    const hasDirective = (node: TS.Node): boolean =>
        ts.isLabeledStatement(node) && (nameText(node.label) === "assert" || nameText(node.label) === "assume")
        || !ts.isFunctionDeclaration(node) && !!ts.forEachChild(node, hasDirective);
    return !!statement.body && !!ts.forEachChild(statement.body, hasDirective);
}
