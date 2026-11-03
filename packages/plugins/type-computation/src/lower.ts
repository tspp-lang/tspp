import { markGenerated } from "@tspp/plugin-sdk";
import type { TSPPSyntaxCursor, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { normalizeMlttTerm, type MlttTerm } from "./core";
import { termToKind, type TypeSyntaxModel } from "./kinds";
import { getDependentBinderMode, unionKeyPrefix } from "./term-parser";

interface Binder {
    readonly name: string;
    readonly domain: MlttTerm;
    readonly mode: "explicit" | "implicit";
}

export const keywordTypes: ReadonlySet<string> = new Set(["any", "bigint", "boolean", "never", "null", "number", "object", "string", "symbol", "undefined", "unknown", "void"]);

/**
 * Builds the ordinary TypeScript type a term stands for, as nodes the checker reads like any other: numbers for
 * naturals, generic signatures for Pi types, and references for the TypeScript types embedded in the term. Matches on
 * types become conditional types, so TypeScript decides them, the same way it decides a `match` on ordinary types and
 * whether or not a binder is still open. A binder over type constructors is a kinded type parameter, and applying it
 * is the same application a higher-kinded parameter gets anywhere else. What only the kernel can state is `unknown`:
 * nothing for a universe, which says nothing about a value, but otherwise `model.unchecked` records it for a warning.
 */
export function lowerTermToTypeNode(ts: TSPPTypeScript, cursor: TSPPSyntaxCursor, model: TypeSyntaxModel, term: MlttTerm, position: number): TS.TypeNode {
    const factory = cursor.factory;
    const kinds = ts.SyntaxKind;
    const reference = (name: string, typeArguments?: readonly TS.TypeNode[]) => factory.createTypeReferenceNode(name, typeArguments && factory.createNodeArray(typeArguments));
    const keyword = (kind: TS.KeywordTypeSyntaxKind) => factory.createKeywordTypeNode(kind);
    const numeric = (value: number) => factory.createLiteralTypeNode(factory.createNumericLiteral(value));
    const tuple = (elements: readonly TS.TypeNode[]) => factory.createTupleTypeNode(factory.createNodeArray(elements));
    const conditional = (check: TS.TypeNode, extendsType: TS.TypeNode, whenTrue: TS.TypeNode, whenFalse: TS.TypeNode) =>
        factory.createConditionalTypeNode(check, extendsType, whenTrue, whenFalse);
    const unknownType = () => keyword(kinds.UnknownKeyword);
    let unchecked = false;
    const uncheckedType = () => {
        unchecked = true;
        return unknownType();
    };

    const constructorBinders = new Set<string>();
    const lowered = asParseTreeNodes(lower(term, []));
    if (unchecked) model.unchecked.add(lowered);
    return lowered;

    /**
     * Generated nodes sit, empty, at `position`, which declaration output and editor services read. A referenced name also
     * has an end, since the checker scans the token after it.
     */
    function asParseTreeNodes<T extends TS.Node>(root: T): T {
        markGenerated(ts, root, position);
        const visit = (node: TS.Node): void => {
            if (ts.isTypeReferenceNode(node)) ts.setTextRange(node.typeName, { pos: -1, end: position });
            ts.forEachChild(node, visit);
        };
        visit(root);
        return root;
    }

    function lower(current: MlttTerm, scope: readonly string[]): TS.TypeNode {
        switch (current.kind) {
            case "universe": return unknownType();
            case "bool-type": return keyword(kinds.BooleanKeyword);
            case "true": return factory.createLiteralTypeNode(factory.createTrue());
            case "false": return factory.createLiteralTypeNode(factory.createFalse());
            case "nat-type": return keyword(kinds.NumberKeyword);
            case "zero": return numeric(0);
            case "successor":
            case "nat-add": return natural(current) ?? keyword(kinds.NumberKeyword);
            case "variable": return scope[current.index] ? reference(scope[current.index]) : unknownType();
            case "external": return lowerExternal(current, scope);
            case "pi": return lowerFunction(current, scope);
            case "bool-elim":
                return conditional(lower(current.scrutinee, scope), factory.createLiteralTypeNode(factory.createTrue()), lower(current.trueCase, scope), lower(current.falseCase, scope));
            case "type-match": return lowerTypeMatch(current, scope);
            case "identity-type":
                return reference("Readonly", [factory.createTypeLiteralNode([
                    property("type", lower(current.type, scope)),
                    property("left", lower(current.left, scope)),
                    property("right", lower(current.right, scope)),
                ])]);
            case "refl": return lower(current.term, scope);
            case "sigma": return factory.createTypeOperatorNode(kinds.ReadonlyKeyword, tuple([lower(current.domain, scope), unknownType()]));
            case "pair": return factory.createTypeOperatorNode(kinds.ReadonlyKeyword, tuple([lower(current.first, scope), lower(current.second, scope)]));
            case "first": return factory.createIndexedAccessTypeNode(lower(current.pair, scope), numeric(0));
            case "second": return factory.createIndexedAccessTypeNode(lower(current.pair, scope), numeric(1));
            case "annotation": return lower(current.term, scope);
            case "lambda": return uncheckedType();
            case "application": return lowerApplication(current, scope);
            case "nat-elim":
            case "identity-elim": return lowerReduced(current, scope);
        }
    }

    /** `P<a>` of a constructor parameter `P`, as the type extension reads it; anything else must reduce first. */
    function lowerApplication(current: Extract<MlttTerm, { kind: "application"; }>, scope: readonly string[]): TS.TypeNode {
        const reduced = normalizeSafely(current);
        if (reduced.kind !== "application") return lower(reduced, scope);
        if (!isConstructorApplication(reduced, scope)) return uncheckedType();
        const target = lower(reduced.functionTerm, scope);
        const argument = lower(reduced.argument, scope);
        const parameters = [target, argument].map((type, index) =>
            factory.createParameterDeclaration(/*modifiers*/ undefined, /*dotDotDotToken*/ undefined, index === 0 ? "__tsppTarget" : "__tsppArgument0", /*questionToken*/ undefined, type)
        );
        const node = factory.createFunctionTypeNode(/*typeParameters*/ undefined, parameters, keyword(kinds.NeverKeyword));
        model.applications.set(node, { target, typeArguments: factory.createNodeArray([argument]) });
        return node;
    }

    function isConstructorApplication(current: MlttTerm, scope: readonly string[]): boolean {
        let head = current;
        while (head.kind === "application") head = head.functionTerm;
        return head.kind === "variable" && constructorBinders.has(scope[head.index]);
    }

    function property(name: string, type: TS.TypeNode) {
        return factory.createPropertySignature(/*modifiers*/ undefined, name, /*questionToken*/ undefined, type);
    }

    function lowerExternal(term: Extract<MlttTerm, { kind: "external"; }>, scope: readonly string[]): TS.TypeNode {
        if (term.key.startsWith(unionKeyPrefix)) return lowerUnion(term, scope);
        if (keywordTypes.has(term.key)) return keywordType(term.key);
        const literal = literalType(term.key);
        if (literal) return literal;
        const typeArguments = term.arguments.map(argument => lower(argument, scope));
        return reference(term.key, typeArguments.length ? typeArguments : undefined);
    }

    function keywordType(name: string): TS.TypeNode {
        switch (name) {
            case "null": return factory.createLiteralTypeNode(factory.createNull());
            case "void": return keyword(kinds.VoidKeyword);
            case "any": return keyword(kinds.AnyKeyword);
            case "bigint": return keyword(kinds.BigIntKeyword);
            case "boolean": return keyword(kinds.BooleanKeyword);
            case "never": return keyword(kinds.NeverKeyword);
            case "number": return keyword(kinds.NumberKeyword);
            case "object": return keyword(kinds.ObjectKeyword);
            case "string": return keyword(kinds.StringKeyword);
            case "symbol": return keyword(kinds.SymbolKeyword);
            case "undefined": return keyword(kinds.UndefinedKeyword);
            default: return keyword(kinds.UnknownKeyword);
        }
    }

    function literalType(text: string): TS.TypeNode | undefined {
        if (/^\d/.test(text)) return factory.createLiteralTypeNode(factory.createNumericLiteral(text));
        if (/^["']/.test(text)) return factory.createLiteralTypeNode(factory.createStringLiteral(text.slice(1, -1)));
        return undefined;
    }

    /** `A | B & C`, whose separators are in the key; intersections bind tighter, as they do in TypeScript. */
    function lowerUnion(term: Extract<MlttTerm, { kind: "external"; }>, scope: readonly string[]): TS.TypeNode {
        const separators = term.key.slice(unionKeyPrefix.length);
        const groups: TS.TypeNode[][] = [[lower(term.arguments[0], scope)]];
        term.arguments.slice(1).forEach((argument, index) => {
            if (separators[index] === "|") groups.push([]);
            groups[groups.length - 1].push(lower(argument, scope));
        });
        const united = groups.map(group => group.length === 1 ? group[0] : factory.createIntersectionTypeNode(factory.createNodeArray(group)));
        return united.length === 1 ? united[0] : factory.createUnionTypeNode(factory.createNodeArray(united));
    }

    function lowerFunction(term: Extract<MlttTerm, { kind: "pi"; }>, outerScope: readonly string[]): TS.TypeNode {
        const binders: Binder[] = [];
        let result: MlttTerm = term;
        while (result.kind === "pi") {
            binders.push({
                name: uniqueName(result.parameterName, binders.map(binder => binder.name)),
                domain: result.domain,
                mode: getDependentBinderMode(result) ?? "explicit",
            });
            result = result.codomain;
        }

        const scope = [...outerScope];
        const typeParameters: TS.TypeParameterDeclaration[] = [];
        const parameters: TS.ParameterDeclaration[] = [];
        binders.forEach((binder, index) => {
            const kind = termToKind(binder.domain);
            // A type constructor has no value to pass, so its binder is only a type parameter.
            if (kind.kind === "function") {
                const parameter = factory.createTypeParameterDeclaration(/*modifiers*/ undefined, binder.name);
                model.declarationKinds.set(parameter, kind);
                typeParameters.push(parameter);
                constructorBinders.add(binder.name);
                scope.unshift(binder.name);
                return;
            }
            const domain = lower(binder.domain, scope);
            const dependent = binder.mode === "implicit" || isReferencedByRemainder(binders, result, index);
            if (dependent) {
                const constraint = domain.kind === kinds.UnknownKeyword ? undefined : domain;
                const parameter = factory.createTypeParameterDeclaration(/*modifiers*/ undefined, binder.name, constraint);
                if (kind.kind === "term") model.declarationKinds.set(parameter, kind);
                typeParameters.push(parameter);
            }
            if (binder.mode === "explicit") {
                parameters.push(factory.createParameterDeclaration(/*modifiers*/ undefined, /*dotDotDotToken*/ undefined, binder.name, /*questionToken*/ undefined, dependent ? reference(binder.name) : domain));
            }
            scope.unshift(binder.name);
        });
        return factory.createFunctionTypeNode(typeParameters.length ? typeParameters : undefined, parameters, lower(result, scope));
    }

    function lowerTypeMatch(term: Extract<MlttTerm, { kind: "type-match"; }>, scope: readonly string[]): TS.TypeNode {
        let result = lower(term.defaultCase, scope);
        for (let index = term.cases.length - 1; index >= 0; index--) {
            const matchCase = term.cases[index];
            const captures = matchCase.captures?.map(capture => capture.name) ?? [];
            const branch = lower(matchCase.result, [...captures, ...scope]);
            result = conditional(tuple([lower(term.scrutinee, scope)]), tuple([lowerPattern(matchCase.pattern, captures, scope)]), branch, result);
        }
        return result;
    }

    function lowerPattern(term: MlttTerm, captures: readonly string[], scope: readonly string[]): TS.TypeNode {
        if (term.kind === "variable" && term.index < captures.length) {
            return factory.createInferTypeNode(factory.createTypeParameterDeclaration(/*modifiers*/ undefined, captures[term.index]));
        }
        if (term.kind === "external" && term.arguments.length && !term.key.startsWith(unionKeyPrefix)) {
            return reference(term.key, term.arguments.map(argument => lowerPattern(argument, captures, scope)));
        }
        return lower(term, [...captures, ...scope]);
    }

    function natural(term: MlttTerm): TS.TypeNode | undefined {
        let current = normalizeSafely(term);
        let value = 0;
        while (current.kind === "successor") {
            value++;
            current = current.predecessor;
        }
        return current.kind === "zero" ? numeric(value) : undefined;
    }

    function lowerReduced(term: MlttTerm, scope: readonly string[]): TS.TypeNode {
        const normalized = normalizeSafely(term);
        // Still the same kind of term, so it is stuck on an open binder; TypeScript has no type for that.
        return normalized.kind === term.kind ? uncheckedType() : lower(normalized, scope);
    }
}

function normalizeSafely(term: MlttTerm): MlttTerm {
    try {
        return normalizeMlttTerm(term);
    }
    catch {
        return term;
    }
}

function uniqueName(preferred: string, existing: readonly string[]): string {
    let name = preferred || "T";
    while (existing.includes(name)) name += "_";
    return name;
}

function isReferencedByRemainder(binders: readonly Binder[], result: MlttTerm, binderIndex: number): boolean {
    for (let index = binderIndex + 1; index < binders.length; index++) {
        if (containsVariable(binders[index].domain, index - binderIndex - 1)) return true;
    }
    return containsVariable(result, binders.length - binderIndex - 1);
}

function containsVariable(value: unknown, index: number): boolean {
    if (!value || typeof value !== "object") return false;
    const candidate = value as { readonly kind?: string; readonly index?: number; };
    if (candidate.kind === "variable" && candidate.index === index) return true;
    return Object.values(value).some(child =>
        Array.isArray(child)
            ? child.some(item => containsVariable(item, index))
            : containsVariable(child, index));
}
