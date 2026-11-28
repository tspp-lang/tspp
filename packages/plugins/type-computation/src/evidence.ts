import type { TSPPDiagnosticProvider, TSPPTypeExtension, TSPPTypeHost, TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

import { evidenceArgumentOf, isEvidence, reifiedTypeProperty, registerEvidence, runtimeShapeOf, runtimeTypeParameterOf } from "./descriptor";
import type { TypeSyntaxModel } from "./kinds";
import type { LoweredTypecase, Reification } from "./reification";

const diagnosticCodes = { openReify: 19105, runtimePattern: 19106 } as const;

/** What a `typecase` on a descriptor of a type parameter knows: the parameter, and the type each arm tests for. */
interface RuntimeTypecase {
    readonly parameter: TS.TypeParameter;
    readonly patterns: readonly (TS.Type | undefined)[];
}

interface State {
    /** The trusted part of `Reified<T>`, by `T`: one type for each `T`, so that `Reified` is invariant. */
    readonly evidence: Map<TS.Type, TS.Type>;
    readonly descriptors: WeakMap<TS.Node, TS.Type>;
    readonly resolving: Set<TS.Node>;
    readonly typecases: WeakMap<LoweredTypecase, RuntimeTypecase | null>;
    readonly preparing: Set<LoweredTypecase>;
}

/** Nodes this extension wrote for a `Reified<T>`, which TypeScript-compatible declarations cannot name. */
export const printedEvidence = new WeakSet<TS.Node>();

/**
 * Runtime type evidence: the trusted `Reified<T>`, and `typecase` on a descriptor whose type only the run time knows.
 *
 * `Reified<T>` is the descriptor's structural type `{ kind: "type"; text: string; __tspp_reified_type: T }`,
 * intersected with a type of this extension's own for `T`. TypeScript reads the descriptor's members and infers `T`
 * from the structural part, while nothing but a descriptor the compiler made has the trusted part: a lookalike object
 * is no `Reified<T>`, and a `Reified<"a">` is no `Reified<string>`. A type assertion stays the unsafe escape it is.
 *
 * A `typecase` on a `Reified<A>` whose `A` is a type parameter, such as one passed in as `(A: Type)` or one a `match`
 * opened, cannot be selected statically. Each arm is checked with `A` refined to `A & Pattern` inside it: what the
 * descriptor proves is that the type is one of the pattern's, not that it is the pattern, so a value of type `A` can be
 * read as the pattern's type while what is written to an `A` must still be an `A`. Patterns are then primitive types,
 * literal types, and their unions, which a descriptor's run-time shape can be tested against.
 */
export function createRuntimeEvidence(ts: TSPPTypeScript, model: TypeSyntaxModel, reification: Reification): {
    readonly typeExtension: TSPPTypeExtension;
    readonly diagnostics: TSPPDiagnosticProvider;
} {
    const states = new WeakMap<TSPPTypeHost, State>();
    const stateOf = (host: TSPPTypeHost): State => {
        let state = states.get(host);
        if (!state) {
            state = { evidence: new Map(), descriptors: new WeakMap(), resolving: new Set(), typecases: new WeakMap(), preparing: new Set() };
            states.set(host, state);
        }
        return state;
    };

    function trusted(host: TSPPTypeHost, state: State, represented: TS.Type): TS.Type {
        let type = state.evidence.get(represented);
        if (!type) {
            type = host.createType();
            registerEvidence(type, represented);
            state.evidence.set(represented, type);
        }
        return type;
    }

    /** Whether a `typecase` dispatches at run time, and on what; undefined while that is being worked out. */
    function prepare(typecase: LoweredTypecase, host: TSPPTypeHost): RuntimeTypecase | undefined {
        const state = stateOf(host);
        const known = state.typecases.get(typecase);
        if (known !== undefined) return known ?? undefined;
        if (state.preparing.has(typecase)) return undefined;
        state.preparing.add(typecase);
        try {
            const parameter = runtimeTypeParameterOf(ts, host.checkExpression(typecase.scrutinee));
            const prepared = parameter ? { parameter, patterns: typecase.patterns.map(pattern => pattern && host.checker.getTypeFromTypeNode(pattern)) } : null;
            state.typecases.set(typecase, prepared);
            return prepared ?? undefined;
        }
        finally {
            state.preparing.delete(typecase);
        }
    }

    const typeExtension: TSPPTypeExtension = {
        resolveTypeNode(node, host) {
            const represented = model.descriptorTypes.get(node);
            if (!represented) return undefined;
            const state = stateOf(host);
            if (state.resolving.has(node)) return undefined;
            const cached = state.descriptors.get(node);
            if (cached) return cached;
            state.resolving.add(node);
            let structural: TS.Type;
            try {
                structural = host.checker.getTypeFromTypeNode(node);
            }
            finally {
                state.resolving.delete(node);
            }
            const type = host.getIntersectionType([trusted(host, state, host.checker.getTypeFromTypeNode(represented)), structural]);
            state.descriptors.set(node, type);
            return type;
        },
        instantiateType(type, mapper, host) {
            if (!isEvidence(type)) return type;
            const represented = evidenceArgumentOf(ts, type)!;
            const instantiated = host.instantiate(represented, mapper);
            return instantiated === represented ? type : trusted(host, stateOf(host), instantiated);
        },
        typeToTypeNode(type, host) {
            const represented = evidenceArgumentOf(ts, type);
            if (!represented) return undefined;
            const flags = ts.NodeBuilderFlags.NoTruncation;
            const argument = host.checker.typeToTypeNode(represented, undefined, flags) ?? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
            const node = ts.factory.createTypeReferenceNode("Reified", [argument]);
            printedEvidence.add(node);
            // `Reified<T>` is the trusted part and the descriptor's members; anything else intersected with it follows.
            const others = type.flags & ts.TypeFlags.Intersection
                ? (type as TS.IntersectionType).types.filter(part => !isEvidence(part) && !host.checker.getPropertyOfType(part, reifiedTypeProperty))
                : [];
            if (!others.length) return node;
            const printed = others.map(part => host.checker.typeToTypeNode(part, undefined, flags));
            return printed.every(part => !!part) ? ts.factory.createIntersectionTypeNode([node, ...printed as TS.TypeNode[]]) : undefined;
        },
        resolveExpressionType(node, host) {
            const typecase = reification.typecases.get(node);
            if (!typecase) return undefined;
            const prepared = prepare(typecase, host);
            if (!prepared) return undefined;
            typecase.patterns.forEach((pattern, index) => {
                if (!pattern) return;
                if (typecase.captures[index]) {
                    host.error(pattern, "'infer' needs the described type at compile time, but this descriptor is of a type parameter, known only at run time.", diagnosticCodes.runtimePattern);
                }
                else if (!Array.isArray(runtimeShapeOf(ts, prepared.patterns[index]!))) {
                    host.error(pattern, "A descriptor of a type parameter is matched at run time, so only primitive types, literal types, and their unions can be told apart.", diagnosticCodes.runtimePattern);
                }
            });
            // A bare type parameter is what a generic call is still inferring, as for a callback of `items.map`.
            const contextual = host.getContextualType(node);
            const expected = contextual && !(contextual.flags & ts.TypeFlags.TypeParameter) ? contextual : undefined;
            const results = typecase.arms.map(arm => host.checkExpression(arm.body as TS.Expression, expected));
            return expected ?? host.getUnionType(results);
        },
        refineTypeAtLocation(type, location, host) {
            if (!reification.typecaseCount()) return undefined;
            const frames: { readonly typecase: LoweredTypecase; readonly index: number; }[] = [];
            for (let node: TS.Node | undefined = location; node; node = node.parent) {
                const arm = reification.typecaseArms.get(node);
                if (arm) frames.push(arm);
            }
            let refined = type;
            // Outer arms first: an inner arm may refine the same parameter further.
            for (const { typecase, index } of frames.reverse()) {
                const prepared = prepare(typecase, host);
                const pattern = prepared?.patterns[index];
                if (!prepared || !pattern) continue;
                const mapper = host.createMapper([prepared.parameter], [host.getIntersectionType([prepared.parameter, pattern])]);
                refined = host.instantiate(refined, mapper);
            }
            return refined === type ? undefined : refined;
        },
    };

    const diagnostics: TSPPDiagnosticProvider = {
        id: "runtime-evidence",
        getSemanticDiagnostics(sourceFile, checker) {
            if (!reification.reifyCount()) return [];
            const found: TS.Diagnostic[] = [];
            const visit = (node: TS.Node): void => {
                const type = reification.reifies.get(node);
                if (type && hasTypeParameter(checker.getTypeFromTypeNode(type), checker)) {
                    const start = type.getStart(sourceFile);
                    found.push({
                        category: ts.DiagnosticCategory.Error,
                        code: diagnosticCodes.openReify,
                        file: sourceFile,
                        start,
                        length: Math.max(1, type.end - start),
                        messageText: "'reify' needs a type known at compile time, and this one has a type parameter in it. To receive a type at run time, take it as a parameter '(A: Type)'.",
                    });
                }
                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
            return found;
        },
    };

    /** Whether a type mentions a declared type parameter, whose descriptor `reify` cannot write down. */
    function hasTypeParameter(type: TS.Type, checker: TS.TypeChecker, seen = new Set<TS.Type>()): boolean {
        if (seen.has(type)) return false;
        seen.add(type);
        if (type.flags & ts.TypeFlags.TypeParameter) return !!type.symbol?.declarations?.some(declaration => ts.isTypeParameterDeclaration(declaration));
        if (type.flags & ts.TypeFlags.UnionOrIntersection) return (type as TS.UnionOrIntersectionType).types.some(part => hasTypeParameter(part, checker, seen));
        if (type.flags & ts.TypeFlags.Object && (type as TS.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
            return checker.getTypeArguments(type as TS.TypeReference).some(argument => hasTypeParameter(argument, checker, seen));
        }
        return (type.aliasTypeArguments ?? []).some(argument => hasTypeParameter(argument, checker, seen));
    }

    return { typeExtension, diagnostics };
}

/**
 * A plugin registers one type extension, so the evidence extension and the kind checker answer as one: evidence first,
 * for the descriptor types and `typecase` expressions it owns, and the kinds for everything else.
 */
export function combineTypeExtensions(evidence: TSPPTypeExtension, kinds: TSPPTypeExtension): TSPPTypeExtension {
    return {
        resolveTypeNode: (node, host) => evidence.resolveTypeNode(node, host) ?? kinds.resolveTypeNode(node, host),
        resolveExpressionType: (node, host) => evidence.resolveExpressionType?.(node, host) ?? kinds.resolveExpressionType?.(node, host),
        refineTypeAtLocation: (type, location, host) => {
            const refined = evidence.refineTypeAtLocation?.(type, location, host) ?? type;
            return kinds.refineTypeAtLocation?.(refined, location, host) ?? (refined === type ? undefined : refined);
        },
        instantiateType: (type, mapper, host) => isEvidence(type) ? evidence.instantiateType(type, mapper, host) : kinds.instantiateType(type, mapper, host),
        isTypeParameterApplicable: typeParameter => !!kinds.isTypeParameterApplicable?.(typeParameter),
        typeToTypeNode: (type, host) => evidence.typeToTypeNode?.(type, host) ?? kinds.typeToTypeNode?.(type, host),
    };
}
