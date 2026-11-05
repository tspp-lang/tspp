import type {
    TSPPDiagnosticMessage,
    TSPPSignatureConstraint,
    TSPPTypeExtension,
    TSPPTypeHost,
    TSPPTypeMapper,
    TSPPTypeOperations,
} from "@tspp/plugin-sdk/compiler";

import {
    chainDiagnosticMessages,
    createSymbolTable,
    Diagnostics,
    emptyArray,
} from "../_namespaces/ts.js";
import type {
    Diagnostic,
    DiagnosticArguments,
    DiagnosticMessage,
    DiagnosticMessageChain,
    GenericType,
    InterfaceType,
    Node,
    NodeLinks,
    Signature,
    Symbol,
    SymbolLinks,
    SymbolTable,
    Type,
    TypeChecker,
    TypeCheckerHost,
    TypeMapper,
    TypeNode,
    TypeParameter,
    TypeReferenceNode,
} from "../types.js";
import {
    SymbolFlags,
    TypeFlags,
} from "../types.js";
import {
    createTSPPDiagnosticMessage,
    getRegisteredTSPPSignatureConstraints,
    getRegisteredTSPPTypeExtensions,
    isTSPPSyntaxAllowedAt,
} from "./registry.js";

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
    readonly getNodeLinks: (node: Node) => NodeLinks;
    readonly getTypeAliasInstantiation: (symbol: Symbol, typeArguments: readonly Type[] | undefined) => Type;
    readonly createTypeReference: (target: GenericType, typeArguments: readonly Type[] | undefined) => Type;
    readonly createTypeMapper: (sources: readonly TypeParameter[], targets: readonly Type[] | undefined) => TypeMapper;
    readonly combineTypeMappers: (first: TypeMapper | undefined, second: TypeMapper) => TypeMapper;
    readonly instantiateType: (type: Type, mapper: TypeMapper | undefined) => Type;
    readonly checkTypeAssignableTo: (
        source: Type,
        target: Type,
        errorNode: Node | undefined,
        headMessage?: DiagnosticMessage,
        containingMessageChain?: () => DiagnosticMessageChain | undefined,
        errorOutputObject?: { errors?: Diagnostic[]; skipLogging?: boolean; },
    ) => boolean;
    readonly getTypeWithThisArgument: (type: Type, thisArgument?: Type) => Type;
    readonly createAnonymousType: (
        symbol: Symbol | undefined,
        members: SymbolTable,
        callSignatures: readonly never[],
        constructSignatures: readonly never[],
        indexInfos: readonly never[],
    ) => Type;
    readonly createInstantiatedSymbolTable: (symbols: Symbol[], mapper: TypeMapper, mappingThisOnly: boolean) => SymbolTable;
    readonly getIntersectionType: (types: readonly Type[]) => Type;
}

/** One checker's type extension hosts and the types each extension created. @internal */
export interface TSPPTypeState {
    readonly getChecker: () => TypeChecker;
    readonly internals: TSPPTypeCheckerInternals;
    readonly hosts: Map<TSPPTypeExtension, TSPPTypeHost>;
    readonly owners: WeakMap<Type, TSPPTypeExtension>;
}

const typeOperations = new WeakMap<TypeCheckerHost, TSPPTypeOperations>();

/** @internal */
export function createTSPPTypeState(checkerHost: TypeCheckerHost, getChecker: () => TypeChecker, internals: TSPPTypeCheckerInternals): TSPPTypeState {
    typeOperations.set(checkerHost, createTypeOperations(internals));
    return { getChecker, internals, hosts: new Map(), owners: new WeakMap() };
}

/** The type operations of the checker created for `checkerHost`, such as a program. @internal */
export function getTSPPTypeOperations(checkerHost: TypeCheckerHost): TSPPTypeOperations | undefined {
    return typeOperations.get(checkerHost);
}

function typeOperationsOf(state: TSPPTypeState): TSPPTypeOperations {
    return createTypeOperations(state.internals);
}

function toDiagnosticMessage(message: TSPPDiagnosticMessage): DiagnosticMessage {
    return createTSPPDiagnosticMessage(message.code, message.message);
}

function createTypeOperations(internals: TSPPTypeCheckerInternals): TSPPTypeOperations {
    return {
        createMapper: (sources, targets) => internals.createTypeMapper(sources as unknown as readonly TypeParameter[], targets as unknown as readonly Type[]) as never,
        combineMappers: (first, second) => internals.combineTypeMappers(first as unknown as TypeMapper | undefined, second as unknown as TypeMapper) as never,
        instantiate: (type, mapper) => internals.instantiateType(type as unknown as Type, mapper as unknown as TypeMapper) as never,
        getTypeWithThisArgument: (type, thisArgument) => internals.getTypeWithThisArgument(type as unknown as Type, thisArgument as unknown as Type | undefined) as never,
        createObjectType: (propertiesIn, mapper) => {
            const properties = propertiesIn as unknown as Symbol[];
            const members = mapper
                ? internals.createInstantiatedSymbolTable(properties, mapper as unknown as TypeMapper, /*mappingThisOnly*/ true)
                : createSymbolTable(properties);
            return internals.createAnonymousType(/*symbol*/ undefined, members, emptyArray, emptyArray, emptyArray) as never;
        },
        getIntersectionType: types => internals.getIntersectionType(types as unknown as readonly Type[]) as never,
        markAliasReferenced: symbol => {
            internals.getSymbolLinks(symbol as unknown as Symbol).referenced = true;
        },
        markAliasVisibleInDeclarations: symbol => {
            for (const declaration of (symbol as unknown as Symbol).declarations ?? []) internals.getNodeLinks(declaration).isVisible = true;
        },
        getAssignabilityError: (source, target, node, headMessage, containingMessage, containingArguments = []) => {
            const output: { errors?: Diagnostic[]; skipLogging?: boolean; } = { skipLogging: true };
            const assignable = internals.checkTypeAssignableTo(
                source as unknown as Type,
                target as unknown as Type,
                node as unknown as Node,
                headMessage && toDiagnosticMessage(headMessage),
                containingMessage && (() => chainDiagnosticMessages(/*details*/ undefined, toDiagnosticMessage(containingMessage), ...containingArguments)),
                output,
            );
            return assignable ? undefined : output.errors?.[0] as never;
        },
    };
}

function getHost(state: TSPPTypeState, extension: TSPPTypeExtension): TSPPTypeHost {
    let host = state.hosts.get(extension);
    if (host) return host;
    const internals = state.internals;
    host = {
        ...createTypeOperations(internals),
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
        checkTypeArgumentConstraint: (typeArgument, constraint, node) => internals.checkTypeAssignableTo(typeArgument as unknown as Type, constraint as unknown as Type, node as unknown as Node, Diagnostics.Type_0_does_not_satisfy_the_constraint_1),
        error: (node, message, code) => void internals.error(node as unknown as Node, createTSPPDiagnosticMessage(code), message),
    };
    state.hosts.set(extension, host);
    return host;
}

/** The type a type extension gives `node`, if any. @internal */
export function resolveTSPPTypeNode(state: TSPPTypeState, node: TypeNode): Type | undefined {
    if (!getRegisteredTSPPTypeExtensions().length || !isTSPPSyntaxAllowedAt(node)) return undefined;
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

/** Whether every overload constraint lets `candidate` be chosen for the call `node`, as instantiated by the call. @internal */
export function isTSPPOverloadApplicable(state: TSPPTypeState, node: Node, candidate: Signature, instantiated: Signature): boolean {
    const declaration = candidate.declaration;
    if (!declaration) return true;
    const request: Parameters<TSPPSignatureConstraint["isOverloadApplicable"]>[0] = {
        node: node as never,
        declaration: declaration as never,
        checker: state.getChecker() as never,
        instantiate: type => state.internals.instantiateType(type as unknown as Type, instantiated.mapper) as never,
    };
    return getRegisteredTSPPSignatureConstraints().every(constraint => constraint.isOverloadApplicable(request));
}

/** Whether every signature constraint lets `source` stand for `target`; `report` hears why it does not. @internal */
export function isTSPPSignatureRelated(state: TSPPTypeState, source: Signature, target: Signature, report: ((message: DiagnosticMessage, ...args: DiagnosticArguments) => void) | undefined): boolean {
    if (source.declaration === target.declaration) return true;
    for (const constraint of getRegisteredTSPPSignatureConstraints()) {
        const problem = constraint.whyNotRelated({
            source: source.declaration as never,
            target: target.declaration as never,
            checker: state.getChecker() as never,
            instantiateSource: type => state.internals.instantiateType(type as unknown as Type, source.mapper) as never,
            instantiateTarget: type => state.internals.instantiateType(type as unknown as Type, target.mapper) as never,
        });
        if (problem) {
            report?.(createTSPPDiagnosticMessage(problem.code), problem.message);
            return false;
        }
    }
    return true;
}

/** A member that a signature constraint adds to `type` for the property access `node`. @internal */
export function getTSPPMember(state: TSPPTypeState, node: Node, leftType: Type, apparentType: Type, name: string): Symbol | undefined {
    if (!isTSPPSyntaxAllowedAt(node)) return undefined;
    const operations = typeOperationsOf(state);
    for (const constraint of getRegisteredTSPPSignatureConstraints()) {
        const member = constraint.getMember?.({ node: node as never, leftType: leftType as never, apparentType: apparentType as never, name, checker: state.getChecker() as never, types: operations });
        if (member) return member as unknown as Symbol;
    }
    return undefined;
}

/** How the type extension that created `type` writes it, if it does. @internal */
export function tsppTypeToTypeNode(state: TSPPTypeState, type: Type): TypeNode | undefined {
    const owner = state.owners.get(type);
    return owner?.typeToTypeNode?.(type as never, getHost(state, owner)) as unknown as TypeNode | undefined;
}
