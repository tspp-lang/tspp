import { maskNonCode } from "@tspp/plugin-sdk";
import type { TSPPAnalysisDiagnostic } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";
import { clauseOwner, matchingBrace, parseProperties } from "./contracts";
import { identifierSource, type Sort } from "./expression";
import { nodeStart, nodeWidth, ts } from "./host-api";
import { modelSignature, refinementFromType, sortFromType, type Clause, type ContractClause, type FunctionModel } from "./models";
import type { RefinementModel } from "./refinements";

// Classes are modeled from their syntax alone: a field's sort comes from its annotation or literal initializer, and a
// receiver's class from the annotation or `new` expression that declares it. Nothing here asks a type checker.

export interface FieldModel {
    readonly name: string;
    /** The proof-state key of the field, as read through `this`. */
    readonly key: string;
    readonly sort: Sort | undefined;
    /** Private or readonly: code outside the class can never write it. */
    readonly encapsulated: boolean;
    readonly type: TS.TypeNode | undefined;
    readonly initializer: TS.Expression | undefined;
    /** The constructor parameter a parameter property is initialized from. */
    readonly parameter: string | undefined;
}

export type MemberKind = "constructor" | "method" | "accessor";

export interface MemberModel {
    readonly name: string;
    readonly kind: MemberKind;
    readonly model: FunctionModel;
    /** Undefined for the implicit constructor of a class that declares none. */
    readonly declaration: TS.ConstructorDeclaration | TS.MethodDeclaration | TS.AccessorDeclaration | undefined;
    readonly isStatic: boolean;
    /** A private member cannot be overridden, so a call through `this` runs exactly this body. */
    readonly isPrivate: boolean;
    readonly hasClause: boolean;
}

export interface ClassModel {
    readonly name: string;
    readonly declaration: TS.ClassDeclaration;
    /** The class named by `extends`, when it is a plain name. */
    readonly base: string | undefined;
    readonly invariants: readonly Clause[];
    readonly numberModel: FunctionModel["numberModel"];
    readonly hasClause: boolean;
    readonly fields: ReadonlyMap<string, FieldModel>;
    /** The fields an invariant reads. */
    readonly invariantFields: ReadonlySet<string>;
    readonly constructorMember: MemberModel;
    readonly methods: ReadonlyMap<string, MemberModel>;
    readonly staticMethods: ReadonlyMap<string, MemberModel>;
    /** Every member with a body, in source order; the implicit constructor comes first. */
    readonly members: readonly MemberModel[];
}

type Report = (start: number, length: number, message: string) => void;

function reporter(fileName: string, diagnostics: TSPPAnalysisDiagnostic[]): Report {
    return (start, length, message) => diagnostics.push({
        fileName, start, length, code: 19006, category: "error", source: "TS++ verification", message,
    });
}

const hasModifier = (node: TS.Node, kind: TS.SyntaxKind) =>
    !!(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier => modifier.kind === kind));

/** A member's name as code writes it after `this.`: identifiers and private names. */
export function memberName(name: TS.PropertyName | TS.Node | undefined): string | undefined {
    return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) ? ts.idText(name) : undefined;
}

interface FoundClause { readonly start: number; readonly properties: readonly { readonly name: string; readonly value: string; readonly start: number; }[]; }

/** The `with { ... }` that directly follows position `from`, when there is one. */
function clauseAt(code: string, sourceText: string, from: number): FoundClause | undefined {
    const match = /^\s*with\s*\{/.exec(code.slice(from, from + 400));
    if (!match) return undefined;
    const start = from + match[0].indexOf("with");
    const open = from + match[0].length - 1;
    const close = matchingBrace(sourceText, open);
    if (close < 0) return undefined;
    return { start, properties: parseProperties(sourceText.slice(open + 1, close), open + 1) };
}

/** Just past the bracket that closes a list ending at `end`, such as parameters or type parameters. */
const after = (code: string, end: number, closing: string) => code.indexOf(closing, end) + 1;

function readNumberModel(clause: FoundClause | undefined, report: Report): FunctionModel["numberModel"] {
    const property = clause?.properties.find(item => item.name === "numberModel");
    if (!property) return undefined;
    const value = property.value.replace(/["']/g, "");
    if (value === "mathematical-real" || value === "safe-integer") return value;
    report(property.start, property.value.length, `numberModel must be "mathematical-real" or "safe-integer".`);
    return undefined;
}

function literalSort(initializer: TS.Expression | undefined, numberModel: FunctionModel["numberModel"]): Sort | undefined {
    if (!initializer) return undefined;
    if (ts.isBigIntLiteral(initializer)) return "Int";
    if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) return "String";
    if (initializer.kind === ts.SyntaxKind.TrueKeyword || initializer.kind === ts.SyntaxKind.FalseKeyword) return "Bool";
    if (ts.isNumericLiteral(initializer) || ts.isPrefixUnaryExpression(initializer) && ts.isNumericLiteral(initializer.operand)) {
        return numberModel === "mathematical-real" ? "Real" : numberModel === "safe-integer" ? "Int" : undefined;
    }
    return undefined;
}

/** Field names an invariant mentions, bare or through `this`. */
function mentionedNames(text: string): string[] {
    return [...text.matchAll(new RegExp(String.raw`(?:\bthis\.)?(${identifierSource})`, "gu"))].map(match => match[1]);
}

/**
 * Models the top-level classes of a file. Every class is modeled, so that verified code can call into any of them;
 * whether a class's own members are verified is decided later.
 */
export function collectClassModels(
    sourceFile: TS.SourceFile, sourceText: string,
    refinements: ReadonlyMap<string, RefinementModel>, records: ReadonlyMap<string, ReadonlyMap<string, Sort>>,
    diagnostics: TSPPAnalysisDiagnostic[],
): Map<string, ClassModel> {
    const report = reporter(sourceFile.fileName, diagnostics);
    const code = maskNonCode(sourceText);
    const classes = new Map<string, ClassModel>();
    const attached = new Set<number>();
    for (const statement of sourceFile.statements) {
        if (!ts.isClassDeclaration(statement) || !statement.name) continue;
        const name = ts.idText(statement.name);
        const header = clauseAt(code, sourceText, statement.typeParameters ? after(code, statement.typeParameters.end, ">") : statement.name.end);
        if (header) attached.add(header.start);
        const numberModel = readNumberModel(header, report);
        const invariants = header?.properties.filter(item => item.name === "invariant") ?? [];

        const fields = new Map<string, FieldModel>();
        const addField = (fieldName: string, node: TS.Node, type: TS.TypeNode | undefined, initializer: TS.Expression | undefined, parameter: string | undefined, encapsulated: boolean) => {
            if (refinementFromType(type, refinements)) {
                report(nodeStart(node, sourceFile), nodeWidth(node, sourceFile), `Refinement types on class fields are not supported; state the condition as a class invariant of '${name}'.`);
            }
            const sort = sortFromType(type, refinements, numberModel) ?? (type ? undefined : literalSort(initializer, numberModel));
            fields.set(fieldName, { name: fieldName, key: `this.${fieldName}`, sort, encapsulated, type, initializer, parameter });
        };
        const declared = statement.members.find(ts.isConstructorDeclaration);
        for (const parameter of declared?.parameters ?? []) {
            if (!ts.isIdentifier(parameter.name) || !ts.isParameterPropertyDeclaration(parameter, declared!)) continue;
            addField(ts.idText(parameter.name), parameter, parameter.type, undefined, ts.idText(parameter.name),
                hasModifier(parameter, ts.SyntaxKind.PrivateKeyword) || hasModifier(parameter, ts.SyntaxKind.ReadonlyKeyword));
        }
        for (const member of statement.members) {
            if (!ts.isPropertyDeclaration(member) || hasModifier(member, ts.SyntaxKind.StaticKeyword)) continue;
            const fieldName = memberName(member.name);
            if (!fieldName) continue;
            addField(fieldName, member, member.type, member.initializer, undefined,
                ts.isPrivateIdentifier(member.name) || hasModifier(member, ts.SyntaxKind.PrivateKeyword) || hasModifier(member, ts.SyntaxKind.ReadonlyKeyword));
        }

        const invariantFields = new Set<string>();
        for (const invariant of invariants) {
            for (const mentioned of mentionedNames(invariant.value)) {
                const field = fields.get(mentioned);
                if (!field) continue;
                invariantFields.add(mentioned);
                if (!field.encapsulated) {
                    report(invariant.start, invariant.value.length, `The invariant of '${name}' reads '${mentioned}', which code outside the class can write; make the field private or readonly.`);
                }
            }
        }

        const members: MemberModel[] = [];
        const methods = new Map<string, MemberModel>();
        const staticMethods = new Map<string, MemberModel>();
        const modelMember = (declaration: NonNullable<MemberModel["declaration"]>, memberLabel: string, kind: MemberKind): MemberModel => {
            const clause = clauseAt(code, sourceText, after(code, declaration.parameters.end, ")"));
            if (clause) attached.add(clause.start);
            const own = readNumberModel(clause, report);
            if (own && numberModel && own !== numberModel) {
                report(clause!.start, 4, `'${name}.${memberLabel}' cannot change the numberModel of its class.`);
            }
            const contract: ContractClause = {
                requires: clause?.properties.filter(item => item.name === "requires") ?? [],
                ensures: clause?.properties.filter(item => item.name === "ensures") ?? [],
                numberModel: own ?? numberModel,
            };
            if (kind === "constructor" && contract.ensures.length) {
                report(contract.ensures[0].start, contract.ensures[0].value.length, "A constructor has no result; state what it establishes as a class invariant.");
            }
            const isStatic = hasModifier(declaration, ts.SyntaxKind.StaticKeyword);
            const model = modelSignature(`${name}.${memberLabel}`, declaration, contract, refinements, records,
                declaration.body ? nodeStart(declaration.body, sourceFile) : declaration.end);
            return {
                name: memberLabel, kind, model, declaration, isStatic, hasClause: !!clause,
                isPrivate: hasModifier(declaration, ts.SyntaxKind.PrivateKeyword) || !!declaration.name && ts.isPrivateIdentifier(declaration.name),
            };
        };
        let constructorMember: MemberModel | undefined;
        for (const member of statement.members) {
            if (ts.isConstructorDeclaration(member)) {
                if (!member.body) continue;
                constructorMember = modelMember(member, "constructor", "constructor");
                members.push(constructorMember);
            }
            else if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
                const label = memberName(member.name);
                if (!label || !member.body) continue;
                const kind: MemberKind = ts.isMethodDeclaration(member) ? "method" : "accessor";
                const modeled = modelMember(member, kind === "accessor" ? `${ts.isGetAccessorDeclaration(member) ? "get" : "set"} ${label}` : label, kind);
                members.push(modeled);
                if (kind === "method") (modeled.isStatic ? staticMethods : methods).set(label, modeled);
            }
        }
        if (!constructorMember) {
            const implicit: FunctionModel = {
                name: `${name}.constructor`, parameters: [], variables: {}, requires: [], ensures: [],
                bodyStart: statement.members.pos, numberModel,
            };
            constructorMember = { name: "constructor", kind: "constructor", model: implicit, declaration: undefined, isStatic: false, isPrivate: false, hasClause: false };
            members.unshift(constructorMember);
        }
        const extendsClause = statement.heritageClauses?.find(clause => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression;
        classes.set(name, {
            name, declaration: statement,
            base: extendsClause && ts.isIdentifier(extendsClause) ? ts.idText(extendsClause) : undefined,
            invariants, numberModel, hasClause: !!header || members.some(member => member.hasClause),
            fields, invariantFields, constructorMember, methods, staticMethods, members,
        });
    }
    // A clause the masking blanked but no model reads would leave its contract silently unchecked.
    for (let pattern = /\bwith\s*\{/g, match; (match = pattern.exec(code));) {
        const owner = clauseOwner(code, match.index);
        if ((owner === "class" || owner === "method") && !attached.has(match.index)) {
            report(match.index, 4, "This contract is not verified: only top-level classes and their constructors, methods, and accessors can have 'with' clauses.");
        }
    }
    return classes;
}

/** Whether a contract clause or a class's syntax asks for its members to be verified. */
export const verifiesClass = (model: ClassModel) => model.hasClause;

function enclosingClass(node: TS.Node): TS.ClassLikeDeclaration | undefined {
    for (let current = node.parent; current; current = current.parent) {
        if (ts.isClassLike(current)) return current;
        // An ordinary function has a `this` of its own; an arrow function shares the enclosing one.
        if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) return undefined;
    }
    return undefined;
}

function classFromType(type: TS.TypeNode | undefined, classes: ReadonlyMap<string, ClassModel>): ClassModel | undefined {
    if (type && ts.isParenthesizedTypeNode(type)) return classFromType(type.type, classes);
    return type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && !type.typeArguments
        ? classes.get(ts.idText(type.typeName)) : undefined;
}

function classOfDeclaration(declaration: TS.VariableDeclaration | TS.ParameterDeclaration, classes: ReadonlyMap<string, ClassModel>): ClassModel | undefined {
    if (declaration.type) return classFromType(declaration.type, classes);
    const initializer = declaration.initializer && skipOuterExpressions(declaration.initializer);
    return initializer && ts.isNewExpression(initializer) && ts.isIdentifier(initializer.expression)
        ? classes.get(ts.idText(initializer.expression)) : undefined;
}

function skipOuterExpressions(node: TS.Expression): TS.Expression {
    while (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    return node;
}

/** The declaration a name refers to at `from`, searched through the scopes that enclose it. */
function declarationOf(name: string, from: TS.Node): TS.VariableDeclaration | TS.ParameterDeclaration | TS.ClassDeclaration | undefined {
    for (let scope: TS.Node | undefined = from.parent; scope; scope = scope.parent) {
        if (ts.isFunctionLike(scope)) {
            const parameter = scope.parameters.find(item => ts.isIdentifier(item.name) && ts.idText(item.name) === name);
            if (parameter) return parameter;
        }
        const statements = ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
            ? scope.statements : undefined;
        for (const statement of statements ?? []) {
            if (ts.isVariableStatement(statement)) {
                const declaration = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && ts.idText(item.name) === name);
                if (declaration) return declaration;
            }
            else if (ts.isClassDeclaration(statement) && statement.name && ts.idText(statement.name) === name) return statement;
        }
    }
    return undefined;
}

/** The class of the object an expression evaluates to, when its syntax says so. */
export function receiverClass(expression: TS.Expression, classes: ReadonlyMap<string, ClassModel>): ClassModel | undefined {
    const node = skipOuterExpressions(expression);
    if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return classFromType(node.type, classes);
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
        const owner = enclosingClass(node);
        return owner && ts.isClassDeclaration(owner) && owner.name && classes.get(ts.idText(owner.name))?.declaration === owner
            ? classes.get(ts.idText(owner.name)) : undefined;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) return classes.get(ts.idText(node.expression));
    if (ts.isIdentifier(node)) {
        const declaration = declarationOf(ts.idText(node), node);
        return declaration && !ts.isClassDeclaration(declaration) ? classOfDeclaration(declaration, classes) : undefined;
    }
    if (ts.isPropertyAccessExpression(node)) {
        const owner = receiverClass(node.expression, classes);
        const field = owner && memberName(node.name) !== undefined ? owner.fields.get(memberName(node.name)!) : undefined;
        return field && classFromType(field.type, classes);
    }
    return undefined;
}

export interface MethodTarget {
    readonly owner: ClassModel;
    readonly member: MemberModel;
    /** `this` and `super` reach the object whose invariant the current member may have broken. */
    readonly receiver: "this" | "super" | "instance" | "static";
}

export function lookupMethod(owner: ClassModel, name: string, classes: ReadonlyMap<string, ClassModel>): { owner: ClassModel; member: MemberModel; } | undefined {
    for (let current: ClassModel | undefined = owner, depth = 0; current && depth < 32; current = current.base ? classes.get(current.base) : undefined, depth++) {
        const member = current.methods.get(name);
        if (member) return { owner: current, member };
    }
    return undefined;
}

/**
 * The modeled method or constructor a call runs, from the syntax of its receiver alone, or undefined when the class
 * is unknown or unmodeled. Used when the host gave no checker resolution, and for calls that syntax plugins generated.
 */
export function resolveCallTargetBySyntax(call: TS.CallExpression | TS.NewExpression, classes: ReadonlyMap<string, ClassModel>): MethodTarget | undefined {
    if (ts.isNewExpression(call)) {
        const owner = ts.isIdentifier(call.expression) ? classes.get(ts.idText(call.expression)) : undefined;
        return owner && { owner, member: owner.constructorMember, receiver: "static" };
    }
    const callee = skipOuterExpressions(call.expression);
    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
        const derived = enclosingClass(call);
        const base = derived && ts.isClassDeclaration(derived) && derived.name ? classes.get(ts.idText(derived.name))?.base : undefined;
        const owner = base ? classes.get(base) : undefined;
        return owner && { owner, member: owner.constructorMember, receiver: "super" };
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const name = memberName(callee.name);
    if (name === undefined) return undefined;
    const receiver = skipOuterExpressions(callee.expression);
    if (ts.isIdentifier(receiver)) {
        const declaration = declarationOf(ts.idText(receiver), receiver);
        const owner = declaration && ts.isClassDeclaration(declaration) ? classes.get(ts.idText(receiver)) : undefined;
        const member = owner?.staticMethods.get(name);
        if (owner) return member && { owner, member, receiver: "static" };
    }
    if (receiver.kind === ts.SyntaxKind.SuperKeyword) {
        const derived = enclosingClass(receiver);
        const base = derived && ts.isClassDeclaration(derived) && derived.name ? classes.get(ts.idText(derived.name))?.base : undefined;
        const found = base && classes.get(base) ? lookupMethod(classes.get(base)!, name, classes) : undefined;
        return found && { ...found, receiver: "super" };
    }
    const owner = receiverClass(receiver, classes);
    const found = owner && lookupMethod(owner, name, classes);
    return found && { ...found, receiver: receiver.kind === ts.SyntaxKind.ThisKeyword ? "this" : "instance" };
}

/** Names of instance methods whose calls owe proofs, to recognize calls whose receiver could not be resolved. */
export function guardedMethodNames(classes: Iterable<ClassModel>): ReadonlySet<string> {
    const names = new Set<string>();
    for (const model of classes) {
        for (const [name, member] of model.methods) {
            if (member.model.requires.length || Object.keys(member.model.parameterRefinements ?? {}).length) names.add(name);
        }
    }
    return names;
}

/**
 * The rules that make an invariant a property of the object, not only of the paths the verifier follows: its fields
 * are written only by the class's own members, through `this`, and `this` never leaves them while the invariant may
 * be broken. Members that cannot be followed at all are refused.
 */
export function reportEncapsulation(model: ClassModel, sourceFile: TS.SourceFile, diagnostics: TSPPAnalysisDiagnostic[]): void {
    if (!model.invariants.length) return;
    const report = reporter(sourceFile.fileName, diagnostics);
    const at = (node: TS.Node, message: string) => report(nodeStart(node, sourceFile), nodeWidth(node, sourceFile), message);
    const declaration = model.declaration;
    if (model.base) at(declaration.heritageClauses![0], `Class invariants are not supported on derived classes yet, so the invariant of '${model.name}' is not verified.`);
    const memberBodies = new Set<TS.Node>(model.members.flatMap(member => member.declaration ? [member.declaration] : []));
    const writeTarget = (node: TS.Node): TS.Expression | undefined =>
        ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
            : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
                    && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) ? node.operand
            : ts.isDeleteExpression(node) ? node.expression
            : undefined;
    const visit = (node: TS.Node, owner: TS.Node | undefined, isStatic: boolean): void => {
        if (ts.isClassLike(node) && node !== declaration) return;
        // An ordinary function's `this` is not the object's.
        if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && !memberBodies.has(node)) return;
        const nextOwner = memberBodies.has(node) ? node : ts.isFunctionLike(node) ? undefined : owner;
        if ((ts.isMethodDeclaration(node) || ts.isAccessor(node)) && memberBodies.has(node) && !hasModifier(node, ts.SyntaxKind.StaticKeyword)
            && (node.asteriskToken || hasModifier(node, ts.SyntaxKind.AsyncKeyword))) {
            at(node.name, `Async and generator members can suspend while the invariant of '${model.name}' is broken, so they are not supported.`);
        }
        if (!isStatic && node.kind === ts.SyntaxKind.ThisKeyword && !(ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node)) {
            at(node, `'this' escapes here, so the invariant of '${model.name}' cannot be verified; only its fields and methods may be used through it.`);
        }
        let target = writeTarget(node);
        while (target && ts.isParenthesizedExpression(target)) target = target.expression;
        if (target && ts.isPropertyAccessExpression(target)) {
            const field = memberName(target.name);
            if (field !== undefined && model.invariantFields.has(field)) {
                if (target.expression.kind !== ts.SyntaxKind.ThisKeyword || isStatic) {
                    at(target, `'${field}' of another '${model.name}' is written here, which its invariant cannot be checked for; write it through 'this'.`);
                }
                else if (!nextOwner) {
                    at(target, `'${field}' is written inside a function that may run at any time, so the invariant of '${model.name}' cannot be verified.`);
                }
            }
        }
        ts.forEachChild(node, child => visit(child, nextOwner, isStatic));
    };
    // A static member's `this` is the class, but it can still write the fields of an instance it is given.
    for (const member of declaration.members) visit(member, undefined, hasModifier(member, ts.SyntaxKind.StaticKeyword) || ts.isClassStaticBlockDeclaration(member));
}
