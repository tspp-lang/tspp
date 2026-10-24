import { hasProperty } from "./core.js";
import {
  SymbolFlags,
  Type,
  TypeChecker,
  TypeFlags,
  UnionType,
} from "./types.js";
import {
  VerificationField,
  VerificationProductSort,
  VerificationSort,
  VerificationSumSort,
} from "./verificationIR.js";
import {
  getNumberModelSort,
  VerificationNumberModel,
} from "./verificationProgramSemantics.js";

/** @internal */
export type VerificationTypeLoweringResult =
  | { readonly sort: VerificationSort; }
  | { readonly reason: string; };

/** @internal */
export function verificationTypeLoweringFailed(result: VerificationTypeLoweringResult): result is { readonly reason: string; } {
  return hasProperty(result, "reason");
}

/** @internal */
export interface VerificationTypeLoweringContext {
  readonly checker: TypeChecker;
  readonly numberModel: VerificationNumberModel | undefined;
}

/**
 * Lowers the type already computed by the TypeScript checker. This layer does
 * not reproduce control-flow narrowing or structural compatibility rules.
 *
 * @internal
 */
export function lowerVerificationType(context: VerificationTypeLoweringContext, type: Type): VerificationTypeLoweringResult {
  return lowerTypeWorker(context, type, new Map(), /*nested*/ false);
}

function lowerTypeWorker(context: VerificationTypeLoweringContext, type: Type, loweredTypes: Map<Type, VerificationSort>, nested: boolean): VerificationTypeLoweringResult {
  if (type.flags & TypeFlags.BooleanLike) return { sort: "Bool" };
  if (type.flags & TypeFlags.BigIntLike) return { sort: "Int" };
  if (type.flags & TypeFlags.NumberLike) {
    if (!context.numberModel) return { reason: 'TypeScript number requires a numberModel ("mathematical-real" or "safe-integer").' };
    // A safe-integer value carries a range fact; fields of structured values have nowhere to attach it yet.
    if (nested && context.numberModel === "safe-integer") return { reason: 'A number field of a structured value is outside the "safe-integer" number model in this version.' };
    return { sort: getNumberModelSort(context.numberModel) };
  }
  if (type.flags & TypeFlags.StringLike) return { sort: "String" };
  const existing = loweredTypes.get(type);
  if (existing) return { sort: existing };
  const result = type.flags & TypeFlags.Union
    ? lowerDiscriminatedUnion(context, type as UnionType, loweredTypes)
    : type.flags & TypeFlags.Object
    ? lowerRecord(context, type, loweredTypes)
    : { reason: `Type '${context.checker.typeToString(type)}' is outside the supported verification subset.` };
  return result;
}

function lowerDiscriminatedUnion(context: VerificationTypeLoweringContext, type: UnionType, loweredTypes: Map<Type, VerificationSort>): VerificationTypeLoweringResult {
  const sort = { kind: "sum", name: context.checker.typeToString(type), variants: [] } as unknown as VerificationSumSort;
  loweredTypes.set(type, sort);
  const variants: VerificationSumSort["variants"][number][] = [];
  const variantNames = new Set<string>();
  for (const member of type.types) {
    const tag = getStringDiscriminant(context.checker, member);
    if (!tag) return loweringFailure(loweredTypes, type, `Union '${context.checker.typeToString(type)}' is not a closed union with a unique string '_tag' discriminant.`);
    if (variantNames.has(tag)) return loweringFailure(loweredTypes, type, `Union '${context.checker.typeToString(type)}' has duplicate '_tag' value '${tag}'.`);
    variantNames.add(tag);
    const fields = lowerProperties(context, member, loweredTypes, /*omitTag*/ true);
    if (propertyLoweringFailed(fields)) return loweringFailure(loweredTypes, type, fields.reason);
    variants.push({ name: tag, fields: fields.fields });
  }
  (sort as { variants: readonly VerificationSumSort["variants"][number][]; }).variants = variants;
  return { sort };
}

function lowerRecord(context: VerificationTypeLoweringContext, type: Type, loweredTypes: Map<Type, VerificationSort>): VerificationTypeLoweringResult {
  if (context.checker.getIndexInfosOfType(type).length) return { reason: `Indexed type '${context.checker.typeToString(type)}' is outside the supported verification subset.` };
  const sort = { kind: "product", name: context.checker.typeToString(type), fields: [] } as unknown as VerificationProductSort;
  loweredTypes.set(type, sort);
  const fields = lowerProperties(context, type, loweredTypes, /*omitTag*/ false);
  if (propertyLoweringFailed(fields)) return loweringFailure(loweredTypes, type, fields.reason);
  (sort as { fields: readonly VerificationField[]; }).fields = fields.fields;
  return { sort };
}

function lowerProperties(
  context: VerificationTypeLoweringContext,
  type: Type,
  loweredTypes: Map<Type, VerificationSort>,
  omitTag: boolean,
): { readonly fields: readonly VerificationField[]; } | { readonly reason: string; } {
  const fields: VerificationField[] = [];
  for (const property of context.checker.getPropertiesOfType(type)) {
    const name = String(property.escapedName);
    if (name.startsWith("__@nominal@") || omitTag && name === "_tag") continue;
    if (property.flags & SymbolFlags.Optional) return { reason: `Optional property '${name}' is outside the supported verification subset.` };
    const propertyType = context.checker.getTypeOfPropertyOfType(type, name);
    if (!propertyType) return { reason: `Property '${name}' has no type available for verification.` };
    const lowered = lowerTypeWorker(context, propertyType, loweredTypes, /*nested*/ true);
    if (verificationTypeLoweringFailed(lowered)) return { reason: `Property '${name}' cannot be lowered: ${lowered.reason}` };
    fields.push({ name, sort: lowered.sort });
  }
  return { fields };
}

function loweringFailure(loweredTypes: Map<Type, VerificationSort>, type: Type, reason: string): VerificationTypeLoweringResult {
  loweredTypes.delete(type);
  return { reason };
}

function propertyLoweringFailed(
  result: { readonly fields: readonly VerificationField[]; } | { readonly reason: string; },
): result is { readonly reason: string; } {
  return hasProperty(result, "reason");
}

function getStringDiscriminant(checker: TypeChecker, type: Type): string | undefined {
  const tagType = checker.getTypeOfPropertyOfType(type, "_tag");
  return tagType && tagType.flags & TypeFlags.StringLiteral ? (tagType as Type & { readonly value: string; }).value : undefined;
}
