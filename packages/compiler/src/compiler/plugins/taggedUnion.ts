import type {
    Expression,
    FunctionDeclaration,
    Identifier,
    ParameterDeclaration,
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
export interface TaggedUnionMatchBinding {
    readonly kind: "binding";
    readonly name: string;
    readonly node: Identifier;
    /** The generated parameter that carries the bound field in the checker tree, when the arm uses it. */
    readonly declaration?: ParameterDeclaration;
}

/** @internal */
export interface TaggedUnionMatchPattern {
    readonly kind: "constructor";
    readonly variant: string;
    readonly variantNode: Identifier;
    readonly elements: readonly (TaggedUnionMatchBinding | TaggedUnionMatchPattern)[];
}

/** @internal */
export interface TaggedUnionMatchArm {
    readonly patterns: readonly TaggedUnionMatchPattern[];
    readonly guard?: Expression;
    readonly result: Expression;
}

/** @internal */
export interface TaggedUnionMatchData {
    readonly scrutinee: Expression;
    readonly temporaryName: string;
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
