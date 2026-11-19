import type * as TS from "typescript-upstream";
import type { TSPPTypeScript } from "@tspp/plugin-sdk/compiler";

import type { GadtDeclaration, NominalDeclarations } from "./declarations";

export interface GadtInstance {
    readonly declaration: GadtDeclaration;
    readonly indices: readonly TS.Type[];
}

/**
 * Finds the nominal brand, including through aliases and inherited members. Wrapper aliases can reorder or erase
 * parameters, so their aliasTypeArguments do not describe the indexed data. The invariant member's instantiated
 * return tuple does: its declaration belongs to the generated brand class, and its type retains the actual indices.
 */
export function findGadt(type: TS.Type, declarations: NominalDeclarations, checker: TS.TypeChecker, ts: TSPPTypeScript): GadtInstance | undefined {
    const seen = new Set<TS.Type>();
    const same = (left: GadtInstance, right: GadtInstance) => left.declaration === right.declaration
        && left.indices.length === right.indices.length && left.indices.every((index, i) => index === right.indices[i]);
    function find(type: TS.Type): GadtInstance | undefined {
        if (seen.has(type)) return undefined;
        seen.add(type);
        if (type.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(type);
            return constraint && constraint !== type ? find(constraint) : undefined;
        }
        if (type.flags & ts.TypeFlags.Union) {
            const instances = (type as TS.UnionType).types.map(find);
            const first = instances[0];
            return first && instances.every(instance => instance && same(first, instance)) ? first : undefined;
        }
        const brand = checker.getPropertyOfType(type, "__tsppNominal");
        let declaration: GadtDeclaration | undefined;
        for (const member of brand?.declarations ?? []) {
            const candidate = declarations.gadtBrands.get(member.parent);
            if (!candidate) continue;
            if (declaration && declaration !== candidate) return undefined;
            declaration = candidate;
        }
        if (declaration) {
            if (!declaration.typeParameters.length) return { declaration, indices: [] };
            const index = checker.getPropertyOfType(type, "__tsppIndex");
            if (!index?.declarations?.some(member => declarations.gadtBrands.get(member.parent) === declaration)) return undefined;
            const indexType = checker.getTypeOfSymbol(index);
            const signatures = checker.getSignaturesOfType(indexType, ts.SignatureKind.Call);
            if (signatures.length !== 1) return undefined;
            const indices = checker.getReturnTypeOfSignature(signatures[0]);
            if (!checker.isTupleType(indices)) return undefined;
            const arguments_ = checker.getTypeArguments(indices as TS.TypeReference);
            return arguments_.length === declaration.typeParameters.length ? { declaration, indices: arguments_ } : undefined;
        }
        if (type.flags & ts.TypeFlags.Intersection) {
            const instances = (type as TS.IntersectionType).types.map(find).filter((instance): instance is GadtInstance => !!instance);
            const first = instances[0];
            return first && instances.every(instance => same(first, instance)) ? first : undefined;
        }
        return undefined;
    }
    return find(type);
}
