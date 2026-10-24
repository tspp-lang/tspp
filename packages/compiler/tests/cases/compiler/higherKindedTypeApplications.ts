// @strict: true
// @declaration: true
// @emitDeclarationOnly: true
// @tsppFeatures: higherKindedTypes,typeUniverses,typeComputation

// @Filename: higherKindedTypeApplications.tspp
export type Id<F: Type => Type>: Type => Type = F;

export type DirectApplication = Id<Array><number>;
export type ParenthesizedApplication = (Id<Array>)<number>;
export type NestedApplication = Id<Id<Array>><string>;
export type LambdaApplication = (<T> =>> T)<string>;

export type Pair<A, B> = [A, B];
export type PreservePair<F: (Type, Type) => Type>: (Type, Type) => Type = F;
export type PairApplication = PreservePair<Pair><string, number>;

export type StringBox<T extends string> = { value: T; };
export type ValidConstrainedApplication = Id<StringBox><"ok">;

declare const numbers: DirectApplication;
numbers.push(1);
// @ts-expect-error -- the applied element type is number
numbers.push("nope");

declare const pair: PairApplication;
pair[0].toUpperCase();
pair[1].toFixed();

// @ts-expect-error -- number[] is not a type constructor
type AppliedOrdinaryType = Id<Array><number><string>;
// @ts-expect-error -- Array accepts one type argument
type WrongArity = Id<Array><number, string>;
// @ts-expect-error -- StringBox retains its constraint through Id
type InvalidConstrainedApplication = Id<StringBox><number>;
