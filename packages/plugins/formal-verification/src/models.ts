import type * as TS from "typescript-upstream";
import { nameText, ts } from "./host-api";
import type { NominalTypesADTAPI } from "@tspp/plugin-nominal-types/api";
import { identifierSource, type Sort } from "./expression";
import { collectFunctionClauses, parseProperties } from "./contracts";
import { refinedTypeEnd, type RefinementModel } from "./refinements";
import { assignedKeys } from "./execution-state";

export interface Clause { readonly value: string; readonly start: number; }
export interface RecordFields extends ReadonlyMap<string, Sort | undefined> {
    /** Fields present in some, but not every, arm of a union. Useful after narrowing, never unconditional summaries. */
    readonly optional?: ReadonlySet<string>;
    readonly literalChoices?: ReadonlyMap<string, readonly string[]>;
    /** Scalar tuple positions of lowered data values, whose named fields are modeled separately. */
    readonly scalarPositions?: ReadonlyMap<string, ReadonlySet<number>>;
}
export const numberSortFromModel = (model: FunctionModel["numberModel"]) =>
    model === "mathematical-real" ? "Real" : model === "safe-integer" ? "NumberInt" : undefined;
export interface FunctionModel {
    readonly name: string;
    /** The parameters proofs can read, whose arguments `parameterPositions` finds among all `arity` of them. */
    readonly parameters: readonly string[];
    readonly parameterPositions?: readonly number[];
    readonly parameterFields?: readonly (string | undefined)[];
    readonly arity?: number;
    readonly variables: Readonly<Record<string, Sort>>;
    readonly requires: readonly Clause[];
    readonly ensures: readonly Clause[];
    readonly bodyStart: number;
    readonly parameterRefinements?: Readonly<Record<string, RefinementModel>>;
    readonly returnRefinement?: RefinementModel;
    readonly numberModel?: "mathematical-real" | "safe-integer";
    readonly returnSort?: Sort;
    readonly returnFields?: RecordFields;
    /** Why a call cannot safely reuse the function's entry-state parameter bindings. */
    readonly callSafetyError?: string;
    /** Aliasing/capture can invalidate this function's own symbolic record fields before its postcondition. */
    readonly verificationSafetyError?: string;
    readonly parameterLiteralChoices?: Readonly<Record<string, readonly string[]>>;
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
    const parameterFields: (string | undefined)[] = [];
    const parameterRefinements: Record<string, RefinementModel> = {};
    const recordParameters = new Map<string, RecordFields>();
    const parameterLiteralChoices: Record<string, readonly string[]> = {};
    for (const [position, parameter] of declaration.parameters.entries()) {
        if (!ts.isIdentifier(parameter.name)) continue;
        const refinement = refinementFromType(parameter.type, refinements);
        const sort = refinement?.sort ?? sortFromType(parameter.type, refinements, numberModel);
        if (sort) {
            parameters.push(nameText(parameter.name));
            parameterPositions.push(position);
            parameterFields.push(undefined);
            variables[nameText(parameter.name)] = sort;
            if (refinement) parameterRefinements[nameText(parameter.name)] = refinement;
        }
        else {
            const fields = fieldsFromType(parameter.type, records);
            if (fields) recordParameters.set(nameText(parameter.name), fields);
            for (const [field, typeSort] of fields ?? []) {
                const sort = typeSort === "NumberInt" ? numberSortFromModel(numberModel) : typeSort;
                if (sort) {
                    const name = `${nameText(parameter.name)}.${field}`;
                    variables[name] = sort;
                    const choices = fields?.literalChoices?.get(field);
                    if (choices && !fields?.optional?.has(field)) parameterLiteralChoices[name] = choices;
                    if (!fields?.optional?.has(field)) {
                        parameters.push(name);
                        parameterPositions.push(position);
                        parameterFields.push(field);
                    }
                }
            }
        }
    }
    const returnRefinement = refinementFromType(declaration.type, refinements);
    const callSafetyError = parameterCallSafety(declaration, parameters, variables, recordParameters, !!contract?.ensures.length || !!returnRefinement);
    return {
        name, parameters, parameterPositions, parameterFields, arity: declaration.parameters.length, variables,
        requires: contract?.requires ?? [], ensures: contract?.ensures ?? [],
        bodyStart, parameterRefinements, returnRefinement, numberModel,
        returnSort: returnRefinement?.sort ?? sortFromType(declaration.type, refinements, numberModel),
        returnFields: guaranteedFields(fieldsFromType(declaration.type, records)),
        callSafetyError,
        verificationSafetyError: callSafetyError === "a record parameter is aliased, escaped, or captured" ? callSafetyError : undefined,
        parameterLiteralChoices,
    };
}

/** Calls share records, while scalar parameters are passed by value. Summaries have no heap or old-value model. */
function parameterCallSafety(declaration: TS.SignatureDeclaration, parameters: readonly string[], variables: Readonly<Record<string, Sort>>,
    records: ReadonlyMap<string, RecordFields>, hasPostcondition: boolean): string | undefined {
    const body = ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) || ts.isConstructorDeclaration(declaration)
        || ts.isGetAccessorDeclaration(declaration) || ts.isSetAccessorDeclaration(declaration) ? declaration.body : undefined;
    if (!body) return undefined;
    let mutation: string | undefined;
    const inspectWrites = (node: TS.Node) => {
        for (const key of assignedKeys(node)) {
            if (records.has(key.split(".")[0])) mutation ??= "a record parameter is written";
            if (hasPostcondition && parameters.includes(key)) mutation ??= "a contracted scalar parameter is reassigned";
        }
    };
    inspectWrites(body);
    let unsafe = false;
    const isImmediateFunction = (node: TS.Node): boolean => {
        if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
        if (node.asteriskToken || node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) return false;
        let target: TS.Node = node;
        while (target.parent && ts.isParenthesizedExpression(target.parent)) target = target.parent;
        return !!target.parent && ts.isCallExpression(target.parent) && target.parent.expression === target;
    };
    const visit = (node: TS.Node, nested = false, inline = false): void => {
        if (ts.isIdentifier(node) && records.has(nameText(node))) {
            const parent = node.parent;
            const positional = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node
                && ts.isElementAccessExpression(parent.parent) && parent.parent.expression === parent
                && ts.isNumericLiteral(parent.parent.argumentExpression)
                && records.get(nameText(node))?.scalarPositions?.get(nameText(parent.name))?.has(Number(nameText(parent.parent.argumentExpression)));
            const readsField = parent && ts.isPropertyAccessExpression(parent) && parent.expression === node
                && (`${nameText(node)}.${nameText(parent.name)}` in variables || positional)
                && !(ts.isCallExpression(parent.parent) && parent.parent.expression === parent);
            const returnsRecord = !inline && parent && ts.isReturnStatement(parent) && parent.expression === node;
            const destructuresScalars = parent && ts.isVariableDeclaration(parent) && parent.initializer === node
                && ts.isObjectBindingPattern(parent.name) && parent.name.elements.every(element =>
                    !element.dotDotDotToken && !element.initializer && ts.isIdentifier(element.name)
                    && (!element.propertyName || ts.isIdentifier(element.propertyName) || ts.isStringLiteral(element.propertyName))
                    && `${nameText(node)}.${nameText(element.propertyName ?? element.name)}` in variables);
            if (nested || (!readsField && !returnsRecord && !destructuresScalars)) unsafe = true;
            let target: TS.Node = node;
            while (target.parent && target.parent !== body) {
                const parent = target.parent;
                if (ts.isBinaryExpression(parent) && parent.left === target
                    && parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
                    && !(ts.isPropertyAccessExpression(target) && target.expression === node)) unsafe = true;
                target = parent;
            }
        }
        // Immediate synchronous calls cannot retain the parameter, but their writes still affect call safety.
        const immediate = isImmediateFunction(node);
        if (immediate && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) inspectWrites(node.body);
        ts.forEachChild(node, child => visit(child, nested || ts.isFunctionLike(node) && !immediate, inline || ts.isFunctionLike(node)));
    };
    visit(body);
    return unsafe ? "a record parameter is aliased, escaped, or captured" : mutation;
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
        const fields = Object.assign(new Map<string, Sort | undefined>(), { literalChoices: new Map<string, readonly string[]>() });
        for (const member of members) {
            if (!ts.isPropertySignature(member) || !member.type || !member.name) continue;
            const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? nameText(member.name) : undefined;
            if (name) fields.set(name, member.questionToken ? undefined : sortFromType(member.type, undefined, "safe-integer"));
            if (name && !member.questionToken && ts.isLiteralTypeNode(member.type) && ts.isStringLiteral(member.type.literal)) {
                fields.literalChoices.set(name, [nameText(member.type.literal)]);
            }
        }
        return fields;
    }
    if (ts.isUnionTypeNode(type)) {
        const fields = Object.assign(new Map<string, Sort | undefined>(), {
            optional: new Set<string>(), literalChoices: new Map<string, readonly string[]>(),
        });
        const parts = type.types.map(part => fieldsFromType(part, records));
        for (const part of type.types) {
            for (const [name, sort] of fieldsFromType(part, records) ?? []) mergeField(fields, name, sort);
        }
        for (const name of fields.keys()) if (parts.some(part => !part?.has(name) || part.optional?.has(name))) fields.optional.add(name);
        for (const name of fields.keys()) {
            if (parts.every(part => part?.literalChoices?.has(name))) {
                fields.literalChoices.set(name, [...new Set(parts.flatMap(part => part?.literalChoices?.get(name) ?? []))]);
            }
        }
        return fields;
    }
    return undefined;
}

function guaranteedFields(fields: RecordFields | undefined): RecordFields | undefined {
    return fields && new Map([...fields].filter(([name]) => !fields.optional?.has(name)));
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
        const fields = Object.assign(new Map<string, Sort | undefined>([[nominalTypes!.tagProperty, "String"]]), {
            optional: new Set<string>(),
            literalChoices: new Map([[nominalTypes!.tagProperty, dataType.variants.map(variant => nominalTypes!.tagOf(variant))]]),
            scalarPositions: new Map<string, ReadonlySet<number>>(),
        });
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
        for (const name of fields.keys()) {
            if (name !== nominalTypes!.tagProperty && dataType.variants.some(variant => !variant.fields.some(field => field.name === name))) {
                fields.optional.add(name);
            }
        }
        const positions = new Set<number>();
        for (const variant of dataType.variants) variant.fields.forEach((_, index) => {
            if (dataType.variants.every(other => !other.fields[index] || fields.get(other.fields[index].name))) positions.add(index);
        });
        fields.scalarPositions.set(nominalTypes!.valuesProperty, positions);
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
