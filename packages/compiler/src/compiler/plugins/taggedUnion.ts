import type {
    Expression,
    FunctionDeclaration,
    Identifier,
    Statement,
    TypeAliasDeclaration,
    TypeNode,
} from "../types.js";

/** Generic tagged-union data retained for plugin-owned declaration syntax. @internal */
export interface TaggedUnionField {
    readonly name: Identifier;
    readonly type: TypeNode;
}

/** @internal */
export interface TaggedUnionVariant {
    readonly name: Identifier;
    readonly fields: readonly TaggedUnionField[];
    readonly type: TypeNode;
    readonly declaration: FunctionDeclaration;
}

/** @internal */
export interface TaggedUnionDeclarationData {
    readonly variants: readonly TaggedUnionVariant[];
}

const taggedUnions = new WeakMap<object, TaggedUnionDeclarationData>();
const taggedUnionMatches = new WeakMap<object, TaggedUnionMatchData>();
const taggedUnionVariants = new WeakMap<object, {
    readonly declaration: TypeAliasDeclaration;
    readonly variant: TaggedUnionVariant;
}>();

/** @internal */
export interface TaggedUnionMatchArm {
    readonly variant: string;
    readonly bindings: readonly string[];
    readonly variantNode: Identifier;
    readonly bindingNodes: readonly Identifier[];
    readonly result: Expression;
}

/** @internal */
export interface TaggedUnionMatchData {
    readonly scrutinee: Expression;
    readonly arms: readonly TaggedUnionMatchArm[];
}

/** @internal */
export function setTaggedUnionData(
    declaration: TypeAliasDeclaration,
    data: TaggedUnionDeclarationData,
): void {
    taggedUnions.set(declaration, data);
    for (const variant of data.variants) {
        taggedUnionVariants.set(variant.declaration, { declaration, variant });
    }
}

/** @internal */
export function getTaggedUnionData(node: object): TaggedUnionDeclarationData | undefined {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const data = taggedUnions.get(current);
        if (data) return data;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export function getTaggedUnionSyntheticDeclarations(node: object): readonly Statement[] {
    return getTaggedUnionData(node)?.variants.map(variant => variant.declaration) ?? [];
}

/** @internal */
export function getTaggedUnionVariantData(node: object): {
    readonly declaration: TypeAliasDeclaration;
    readonly variant: TaggedUnionVariant;
} | undefined {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const data = taggedUnionVariants.get(current);
        if (data) return data;
        current = current.original;
    }
    return undefined;
}

/** @internal */
export function setTaggedUnionMatchData(node: Expression, data: TaggedUnionMatchData): void {
    taggedUnionMatches.set(node, data);
}

/** @internal */
export function getTaggedUnionMatchData(node: object): TaggedUnionMatchData | undefined {
    let current: { readonly original?: object; } | undefined = node;
    while (current) {
        const data = taggedUnionMatches.get(current);
        if (data) return data;
        current = current.original;
    }
    return undefined;
}

