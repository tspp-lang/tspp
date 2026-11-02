import type {
    TSPPTypeExtension,
    TSPPTypeHost,
    TSPPTypeMapper,
} from "@tspp/plugin-sdk/compiler";

import { Diagnostics } from "../_namespaces/ts.js";
import type {
    DiagnosticArguments,
    DiagnosticMessage,
    GenericType,
    InterfaceType,
    Node,
    Symbol,
    SymbolLinks,
    Type,
    TypeChecker,
    TypeMapper,
    TypeNode,
    TypeParameter,
    TypeReferenceNode,
} from "../types.js";
import {
    SymbolFlags,
    TypeFlags,
} from "../types.js";
import { getRegisteredTSPPTypeExtensions } from "./registry.js";

/** The checker functions behind the hosts that type extensions receive. @internal */
export interface TSPPTypeCheckerInternals {
    readonly createType: (flags: TypeFlags) => Type;
    readonly getErrorType: () => Type;
    readonly getUnknownSymbol: () => Symbol;
    readonly error: (location: Node | undefined, message: DiagnosticMessage, ...args: DiagnosticArguments) => unknown;
    readonly resolveTypeReferenceName: (node: TypeReferenceNode, meaning: SymbolFlags, ignoreErrors?: boolean) => Symbol;
    readonly resolveAlias: (symbol: Symbol) => Symbol;
    readonly getDeclaredTypeOfSymbol: (symbol: Symbol) => Type;
    readonly getSymbolLinks: (symbol: Symbol) => SymbolLinks;
    readonly getTypeAliasInstantiation: (symbol: Symbol, typeArguments: readonly Type[] | undefined) => Type;
    readonly createTypeReference: (target: GenericType, typeArguments: readonly Type[] | undefined) => Type;
    readonly createTypeMapper: (sources: readonly TypeParameter[], targets: readonly Type[] | undefined) => TypeMapper;
    readonly combineTypeMappers: (first: TypeMapper | undefined, second: TypeMapper) => TypeMapper;
    readonly instantiateType: (type: Type, mapper: TypeMapper | undefined) => Type;
    readonly checkTypeAssignableTo: (source: Type, target: Type, errorNode: Node | undefined, headMessage?: DiagnosticMessage) => boolean;
}

/** One checker's type extension hosts and the types each extension created. @internal */
export interface TSPPTypeState {
    readonly getChecker: () => TypeChecker;
    readonly internals: TSPPTypeCheckerInternals;
    readonly hosts: Map<TSPPTypeExtension, TSPPTypeHost>;
    readonly owners: WeakMap<Type, TSPPTypeExtension>;
}

/** @internal */
export function createTSPPTypeState(getChecker: () => TypeChecker, internals: TSPPTypeCheckerInternals): TSPPTypeState {
    return { getChecker, internals, hosts: new Map(), owners: new WeakMap() };
}

function getHost(state: TSPPTypeState, extension: TSPPTypeExtension): TSPPTypeHost {
    let host = state.hosts.get(extension);
    if (host) return host;
    const internals = state.internals;
    host = {
        get checker() {
            return state.getChecker() as never;
        },
        get errorType() {
            return internals.getErrorType() as never;
        },
        createType: symbol => {
            const type = internals.createType(TypeFlags.TypeParameter);
            if (symbol) type.symbol = symbol as unknown as Symbol;
            state.owners.set(type, extension);
            return type as never;
        },
        resolveTypeReferenceName: node => {
            const symbol = internals.resolveTypeReferenceName(node as unknown as TypeReferenceNode, SymbolFlags.Type, /*ignoreErrors*/ true);
            if (symbol === internals.getUnknownSymbol()) return undefined;
            return (symbol.flags & SymbolFlags.Alias ? internals.resolveAlias(symbol) : symbol) as never;
        },
        getTypeParametersOfSymbol: symbolIn => {
            const symbol = symbolIn as unknown as Symbol;
            if (symbol.flags & SymbolFlags.TypeAlias) {
                internals.getDeclaredTypeOfSymbol(symbol);
                return internals.getSymbolLinks(symbol).typeParameters as never;
            }
            if (symbol.flags & (SymbolFlags.Class | SymbolFlags.Interface)) {
                return (internals.getDeclaredTypeOfSymbol(symbol) as InterfaceType).localTypeParameters as never;
            }
            return undefined;
        },
        instantiateGenericType: (symbolIn, typeArguments) => {
            const symbol = symbolIn as unknown as Symbol;
            if (symbol.flags & SymbolFlags.TypeAlias) return internals.getTypeAliasInstantiation(symbol, typeArguments as unknown as readonly Type[]) as never;
            const declared = internals.getDeclaredTypeOfSymbol(symbol) as GenericType;
            return internals.createTypeReference(declared, [...declared.outerTypeParameters ?? [], ...typeArguments as unknown as readonly Type[]]) as never;
        },
        createMapper: (sources, targets) => internals.createTypeMapper(sources as unknown as readonly TypeParameter[], targets as unknown as readonly Type[]) as never,
        combineMappers: (first, second) => internals.combineTypeMappers(first as unknown as TypeMapper | undefined, second as unknown as TypeMapper) as never,
        instantiate: (type, mapper) => internals.instantiateType(type as unknown as Type, mapper as unknown as TypeMapper) as never,
        checkTypeArgumentConstraint: (typeArgument, constraint, node) => internals.checkTypeAssignableTo(typeArgument as unknown as Type, constraint as unknown as Type, node as unknown as Node, Diagnostics.Type_0_does_not_satisfy_the_constraint_1),
        error: (node, message) => void internals.error(node as unknown as Node, Diagnostics._0, message),
    };
    state.hosts.set(extension, host);
    return host;
}

/** The type a type extension gives `node`, if any. @internal */
export function resolveTSPPTypeNode(state: TSPPTypeState, node: TypeNode): Type | undefined {
    for (const extension of getRegisteredTSPPTypeExtensions()) {
        const type = extension.resolveTypeNode(node as never, getHost(state, extension));
        if (type) return type as unknown as Type;
    }
    return undefined;
}

/** A type extension's instantiation of a type it created; undefined for other types. @internal */
export function instantiateTSPPType(state: TSPPTypeState, type: Type, mapper: TypeMapper): Type | undefined {
    const owner = state.owners.get(type);
    return owner && owner.instantiateType(type as never, mapper as unknown as TSPPTypeMapper, getHost(state, owner)) as unknown as Type;
}

/** Whether a type extension lets a type reference with type arguments name `typeParameter`. @internal */
export function isTSPPTypeParameterApplicable(typeParameter: TypeParameter): boolean {
    for (const extension of getRegisteredTSPPTypeExtensions()) {
        if (extension.isTypeParameterApplicable?.(typeParameter as never)) return true;
    }
    return false;
}

/** How the type extension that created `type` writes it, if it does. @internal */
export function tsppTypeToTypeNode(state: TSPPTypeState, type: Type): TypeNode | undefined {
    const owner = state.owners.get(type);
    return owner?.typeToTypeNode?.(type as never, getHost(state, owner)) as unknown as TypeNode | undefined;
}
