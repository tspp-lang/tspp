import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";
import type * as TS from "typescript-upstream";

/** The phantom property through which a descriptor's static type carries the type it describes. */
export const reifiedTypeProperty = "__tspp_reified_type";

/**
 * How a descriptor describes its type at run time: the atoms the type is the union of, such as `"number"`, `"string:a"`,
 * or `"boolean:true"`; `"any"`; or undefined, for a type no run-time pattern can match, such as an object type.
 */
export type RuntimeShape = readonly string[] | "any" | undefined;

/**
 * The trusted part of each `Reified<T>` a checker made, with its `T`. It is a type of the evidence extension, which
 * nothing but itself is assignable to, so a structural copy of a descriptor is not a `Reified<T>`. Types are unique to
 * the checker that made them, so one map serves every checker, including the one emit asks.
 */
const evidenceArguments = new WeakMap<TS.Type, TS.Type>();

export function registerEvidence(evidence: TS.Type, represented: TS.Type): void {
    evidenceArguments.set(evidence, represented);
}

export function isEvidence(type: TS.Type): boolean {
    return evidenceArguments.has(type);
}

/** The `T` of a `Reified<T>`, which is the trusted part intersected with the descriptor's structural type. */
export function evidenceArgumentOf(ts: TSPPTypeScript, type: TS.Type): TS.Type | undefined {
    const direct = evidenceArguments.get(type);
    if (direct) return direct;
    if (!(type.flags & ts.TypeFlags.Intersection)) return undefined;
    for (const part of (type as TS.IntersectionType).types) {
        const represented = evidenceArguments.get(part);
        if (represented) return represented;
    }
    return undefined;
}

/**
 * The type parameter a `Reified<A>` describes, when only the run time knows which type it is: a type parameter of a
 * signature, such as the `A` of `(A: Type, value: A) => ...`, or a hidden type a `match` opened. A known type, even
 * one with type parameters in it, is matched statically.
 */
export function runtimeTypeParameterOf(ts: TSPPTypeScript, type: TS.Type): TS.TypeParameter | undefined {
    const represented = evidenceArgumentOf(ts, type);
    if (!represented || !(represented.flags & ts.TypeFlags.TypeParameter) || evidenceArguments.has(represented)) return undefined;
    // Types other plugins create look like type parameters too; a type parameter has a declaration.
    if (!represented.symbol?.declarations?.some(declaration => ts.isTypeParameterDeclaration(declaration))) return undefined;
    return represented as TS.TypeParameter;
}

/** What a descriptor of `type` carries at run time, which emit and the checker compute alike. */
export function runtimeShapeOf(ts: TSPPTypeScript, type: TS.Type): RuntimeShape {
    if (type.flags & ts.TypeFlags.Any) return "any";
    // `never` is the empty union, which every pattern covers, as every type is assignable from it.
    if (type.flags & ts.TypeFlags.Never) return [];
    const atoms = new Set<string>();
    for (const part of type.flags & ts.TypeFlags.Union ? (type as TS.UnionType).types : [type]) {
        const atom = atomOf(ts, part);
        if (atom === undefined) return undefined;
        atoms.add(atom);
    }
    return [...atoms];
}

function atomOf(ts: TSPPTypeScript, type: TS.Type): string | undefined {
    const flags = type.flags;
    const kinds = ts.TypeFlags;
    if (flags & kinds.StringLiteral) return `string:${(type as TS.StringLiteralType).value}`;
    if (flags & kinds.NumberLiteral) return `number:${(type as TS.NumberLiteralType).value}`;
    if (flags & kinds.BigIntLiteral) {
        const { negative, base10Value } = (type as TS.BigIntLiteralType).value;
        return `bigint:${negative ? "-" : ""}${base10Value}`;
    }
    if (flags & kinds.BooleanLiteral) return `boolean:${(type as TS.Type & { readonly intrinsicName: string; }).intrinsicName}`;
    if (flags & kinds.String) return "string";
    if (flags & kinds.Number) return "number";
    if (flags & kinds.BigInt) return "bigint";
    if (flags & kinds.ESSymbol) return "symbol";
    if (flags & (kinds.Undefined | kinds.Void)) return "undefined";
    if (flags & kinds.Null) return "null";
    return undefined;
}
