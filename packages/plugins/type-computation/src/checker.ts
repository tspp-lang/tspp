import type { TSPPTypeExtension, TSPPTypeHost, TSPPTypeMapper, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { kindsEqual, kindToString, ordinaryKind, type TypeKind, type TypeSyntaxModel, universeLevel } from "./kinds";

interface ConstructorData {
    readonly node: TS.FunctionTypeNode;
    readonly typeParameters: readonly TS.TypeParameter[];
    readonly outerMapper?: TSPPTypeMapper;
}

interface ApplicationData {
    readonly target: TS.Type;
    readonly typeArguments: readonly TS.Type[];
}

/** One checker's types for kinds: constructors, applications that wait for their target, and universes. */
interface CheckerState {
    readonly kinds: WeakMap<TS.Type, TypeKind>;
    readonly constructors: WeakMap<TS.Type, ConstructorData>;
    readonly namedConstructors: WeakMap<TS.Type, TS.Symbol>;
    readonly namedConstructorsBySymbol: Map<TS.Symbol, TS.Type>;
    readonly applications: WeakMap<TS.Type, ApplicationData>;
    readonly universes: Map<number, TS.Type>;
    readonly universeLevels: WeakMap<TS.Type, number>;
    readonly nodeTypes: WeakMap<TS.Node, TS.Type | null>;
    readonly resolving: Set<TS.Node>;
}

/**
 * Kinds for type constructors: a type parameter annotated `F: Type => Type` can be applied (`F<A>`), named generic
 * types and anonymous constructors `<T> =>> B` can be passed for it, applications of a type parameter wait until it
 * is instantiated, and universes `Type0`, `Type1`... are types whose kind is the next universe.
 */
export function createKindChecker(ts: TSPPTypeScript, model: TypeSyntaxModel): TSPPTypeExtension {
    const states = new WeakMap<TSPPTypeHost, CheckerState>();
    const stateOf = (host: TSPPTypeHost) => {
        let state = states.get(host);
        if (!state) {
            state = {
                kinds: new WeakMap(),
                constructors: new WeakMap(),
                namedConstructors: new WeakMap(),
                namedConstructorsBySymbol: new Map(),
                applications: new WeakMap(),
                universes: new Map(),
                universeLevels: new WeakMap(),
                nodeTypes: new WeakMap(),
                resolving: new Set(),
            };
            states.set(host, state);
        }
        return state;
    };

    const declarationKind = (symbol: TS.Symbol | undefined): TypeKind | undefined => {
        for (const declaration of symbol?.declarations ?? []) {
            const kind = model.declarationKinds.get(declaration);
            if (kind) return kind;
        }
        return undefined;
    };

    return {
        resolveTypeNode(node, host) {
            if (!model.used && !isUniverseCandidate(node)) return undefined;
            const state = stateOf(host);
            if (state.resolving.has(node)) return undefined;
            const cached = state.nodeTypes.get(node);
            if (cached !== undefined) return cached ?? undefined;
            const type = resolve(node, host, state);
            state.nodeTypes.set(node, type ?? null);
            return type;
        },
        instantiateType(type, mapper, host) {
            const state = stateOf(host);
            const application = state.applications.get(type);
            if (application) {
                // A curried application `F<A><B>` targets the waiting `F<A>`, which instantiation applies again.
                return apply(
                    host,
                    state,
                    host.instantiate(application.target, mapper),
                    application.typeArguments.map(argument => host.instantiate(argument, mapper)),
                    /*errorNode*/ undefined,
                );
            }
            const constructor = state.constructors.get(type);
            if (constructor) {
                const result = host.createType(type.symbol);
                state.constructors.set(result, { ...constructor, outerMapper: host.combineMappers(constructor.outerMapper, mapper) });
                const kind = state.kinds.get(type);
                if (kind) state.kinds.set(result, kind);
                return result;
            }
            return type;
        },
        isTypeParameterApplicable: typeParameter => declarationKind(typeParameter.symbol)?.kind === "function",
        typeToTypeNode(type, host) {
            const level = stateOf(host).universeLevels.get(type);
            return level === undefined ? undefined : ts.factory.createTypeReferenceNode(`Type${level}`);
        },
    };

    function isUniverseCandidate(node: TS.Node): boolean {
        return ts.isTypeReferenceNode(node) && !node.typeArguments && ts.isIdentifier(node.typeName) && universeLevel(ts.idText(node.typeName)) !== undefined;
    }

    function getKind(state: CheckerState, type: TS.Type): TypeKind {
        return state.kinds.get(type) ?? declarationKind(type.symbol) ?? ordinaryKind;
    }

    function resolve(node: TS.TypeNode, host: TSPPTypeHost, state: CheckerState): TS.Type | undefined {
        const own = resolveOwn(node, host, state);
        const expected = model.used ? expectedKind(node, host, state) : undefined;
        if (!expected) return own;
        if (!own && expected.kind === "function" && ts.isTypeReferenceNode(node) && !node.typeArguments) {
            const symbol = host.resolveTypeReferenceName(node);
            const declared = symbol && symbol.flags & ts.SymbolFlags.Type ? host.checker.getDeclaredTypeOfSymbol(symbol) : undefined;
            if (declared && getKind(state, declared).kind === "function") return checkKind(host, state, declared, expected, node);
            const constructor = symbol && namedConstructor(host, state, symbol);
            if (constructor) return checkKind(host, state, constructor, expected, node);
        }
        return checkKind(host, state, own ?? resolveOrdinarily(node, host, state), expected, node);
    }

    function resolveOrdinarily(node: TS.TypeNode, host: TSPPTypeHost, state: CheckerState): TS.Type {
        state.resolving.add(node);
        try {
            return host.checker.getTypeFromTypeNode(node);
        }
        finally {
            state.resolving.delete(node);
        }
    }

    /** The type of syntax this plugin owns, or of a reference that applies a type constructor or names a universe. */
    function resolveOwn(node: TS.TypeNode, host: TSPPTypeHost, state: CheckerState): TS.Type | undefined {
        const application = model.applications.get(node);
        if (application) {
            const target = host.checker.getTypeFromTypeNode(application.target);
            return apply(host, state, target, application.typeArguments.map(argument => host.checker.getTypeFromTypeNode(argument)), node);
        }
        if (model.constructors.has(node)) return createConstructor(host, state, node as TS.FunctionTypeNode);
        if (!ts.isTypeReferenceNode(node)) return undefined;
        if (!node.typeArguments) {
            const level = ts.isIdentifier(node.typeName) ? universeLevel(ts.idText(node.typeName)) : undefined;
            return level !== undefined && !host.resolveTypeReferenceName(node) ? universe(host, state, level) : undefined;
        }
        if (!model.used) return undefined;
        // Ordinary TypeScript rejects type arguments on a type parameter or on an alias without type parameters.
        const symbol = host.resolveTypeReferenceName(node);
        if (!symbol || !(symbol.flags & (ts.SymbolFlags.TypeParameter | ts.SymbolFlags.TypeAlias)) || host.getTypeParametersOfSymbol(symbol)?.length) return undefined;
        const target = host.checker.getDeclaredTypeOfSymbol(symbol);
        if (getKind(state, target).kind !== "function") return undefined;
        return apply(host, state, target, node.typeArguments.map(argument => host.checker.getTypeFromTypeNode(argument)), node);
    }

    /** The kind a type node must have where it appears: as a type argument, or as the body of an annotated alias. */
    function expectedKind(node: TS.TypeNode, host: TSPPTypeHost, state: CheckerState): TypeKind | undefined {
        const parent = node.parent;
        if (!parent) return undefined;
        if (ts.isTypeAliasDeclaration(parent)) return parent.type === node ? model.declarationKinds.get(parent) : undefined;
        if (ts.isParameter(parent) && parent.type === node && model.applications.has(parent.parent)) {
            const index = (parent.parent as TS.FunctionTypeNode).parameters.indexOf(parent);
            if (index === 0) return undefined;
            const kind = getKind(state, host.checker.getTypeFromTypeNode(model.applications.get(parent.parent)!.target));
            return kind.kind === "function" ? kind.parameters[index - 1] : undefined;
        }
        if (!ts.isTypeReferenceNode(parent) || !parent.typeArguments) return undefined;
        const index = parent.typeArguments.indexOf(node);
        if (index < 0) return undefined;
        // Only references that may carry a constructor are checked; other arguments are ordinary types.
        if (!ts.isTypeReferenceNode(node) && !model.constructors.has(node) && !model.applications.has(node)) {
            const kind = targetParameterKind(parent, index, host, state);
            return kind?.kind === "function" ? kind : undefined;
        }
        return targetParameterKind(parent, index, host, state);
    }

    function targetParameterKind(reference: TS.TypeReferenceNode, index: number, host: TSPPTypeHost, state: CheckerState): TypeKind | undefined {
        const symbol = host.resolveTypeReferenceName(reference);
        if (!symbol) return undefined;
        const parameters = host.getTypeParametersOfSymbol(symbol);
        if (parameters?.length) return parameters[index] && getKind(state, parameters[index]);
        if (!(symbol.flags & (ts.SymbolFlags.TypeParameter | ts.SymbolFlags.TypeAlias))) return undefined;
        const kind = getKind(state, host.checker.getDeclaredTypeOfSymbol(symbol));
        return kind.kind === "function" ? kind.parameters[index] : undefined;
    }

    function checkKind(host: TSPPTypeHost, state: CheckerState, type: TS.Type, expected: TypeKind, node: TS.Node): TS.Type {
        if (type === host.errorType) return type;
        const actual = getKind(state, type);
        if (kindsEqual(actual, expected)) return type;
        host.error(node, `Type '${host.checker.typeToString(type)}' has kind '${kindToString(actual)}', but kind '${kindToString(expected)}' was expected.`);
        return host.errorType;
    }

    /** Applies a type constructor; errors are reported only at `errorNode`, never while instantiating. */
    function apply(host: TSPPTypeHost, state: CheckerState, target: TS.Type, typeArguments: readonly TS.Type[], errorNode: TS.Node | undefined): TS.Type {
        if (target === host.errorType || typeArguments.includes(host.errorType)) return host.errorType;
        const kind = getKind(state, target);
        if (kind.kind !== "function") {
            if (errorNode) host.error(errorNode, `Type '${host.checker.typeToString(target)}' is not generic.`);
            return host.errorType;
        }
        if (kind.parameters.length !== typeArguments.length) {
            if (errorNode) {
                host.error(errorNode, `Type constructor '${host.checker.typeToString(target)}' must be applied to ${kind.parameters.length} type argument(s).`);
            }
            return host.errorType;
        }
        for (let index = 0; index < typeArguments.length; index++) {
            if (kindsEqual(getKind(state, typeArguments[index]), kind.parameters[index])) continue;
            return errorNode ? checkKind(host, state, typeArguments[index], kind.parameters[index], errorNode) : host.errorType;
        }
        const constructor = state.constructors.get(target);
        if (constructor) {
            const mapper = host.combineMappers(constructor.outerMapper, host.createMapper(constructor.typeParameters, typeArguments));
            if (errorNode) {
                constructor.node.typeParameters?.forEach((parameter, index) => {
                    const constraint = ts.getEffectiveConstraintOfTypeParameter(parameter);
                    if (constraint) host.checkTypeArgumentConstraint(typeArguments[index], host.instantiate(host.checker.getTypeFromTypeNode(constraint), mapper), errorNode);
                });
            }
            return host.instantiate(host.checker.getTypeFromTypeNode(constructor.node.type), mapper);
        }
        const symbol = state.namedConstructors.get(target);
        if (symbol) return host.instantiateGenericType(symbol, typeArguments);
        const result = host.createType(target.symbol);
        state.applications.set(result, { target, typeArguments });
        state.kinds.set(result, kind.result);
        return result;
    }

    function createConstructor(host: TSPPTypeHost, state: CheckerState, node: TS.FunctionTypeNode): TS.Type {
        const typeParameters = (node.typeParameters ?? []).map(parameter =>
            host.checker.getDeclaredTypeOfSymbol(host.checker.getSymbolAtLocation(parameter.name)!) as TS.TypeParameter
        );
        const type = host.createType();
        state.constructors.set(type, { node, typeParameters });
        state.kinds.set(type, {
            kind: "function",
            parameters: typeParameters.map(parameter => getKind(state, parameter)),
            result: getKind(state, host.checker.getTypeFromTypeNode(node.type)),
        });
        return type;
    }

    /** A generic alias, class, or interface named without type arguments where a type constructor is expected. */
    function namedConstructor(host: TSPPTypeHost, state: CheckerState, symbol: TS.Symbol): TS.Type | undefined {
        const cached = state.namedConstructorsBySymbol.get(symbol);
        if (cached) return cached;
        const typeParameters = host.getTypeParametersOfSymbol(symbol);
        if (!typeParameters?.length) return undefined;
        const type = host.createType(symbol);
        state.namedConstructors.set(type, symbol);
        state.kinds.set(type, { kind: "function", parameters: typeParameters.map(parameter => getKind(state, parameter)), result: ordinaryKind });
        state.namedConstructorsBySymbol.set(symbol, type);
        return type;
    }

    function universe(host: TSPPTypeHost, state: CheckerState, level: number): TS.Type {
        let type = state.universes.get(level);
        if (!type) {
            type = host.createType();
            state.kinds.set(type, { kind: "type", level: level + 1 });
            state.universes.set(level, type);
            state.universeLevels.set(type, level);
        }
        return type;
    }
}
