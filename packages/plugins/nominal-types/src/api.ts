// The API nominal-types publishes under `nominal-types/adt` (see `provides` in the manifest). Dependents declare
// nominal-types in `requires` or `optionalDependencies`, read the API with `context.dependencies.get`, and import
// these types with `import type` from `@tspp/plugin-nominal-types/api`.

export interface NominalDataField {
    readonly name: string;
    /** The field's type as written. */
    readonly type: string;
}

export interface NominalDataVariant {
    readonly name: string;
    readonly fields: readonly NominalDataField[];
}

export interface NominalDataType {
    readonly name: string;
    readonly typeParameters: readonly string[];
    readonly variants: readonly NominalDataVariant[];
}

export interface NominalTypesADTAPI {
    /** The property whose string value names the variant of a data value at run time. */
    readonly tagProperty: string;
    /** The run-time value of `tagProperty` for a variant. */
    tagOf(variant: NominalDataVariant): string;
    /** The `data` declarations of a source text, in source order. */
    getDataTypes(sourceText: string): readonly NominalDataType[];
}
