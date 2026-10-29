//// [tests/cases/compiler/higherKindedTypeAliases.ts] ////

//// [higherKindedTypeAliases.tspp]
export interface AcceptsUnary<F: Type => Type> {
    value: F<string>;
}

export type Pair<A, B> = [A, B];

export type ArrayConstructor: Type => Type = Array;
export type ArrayConstructorAlias: Type => Type = ArrayConstructor;
export type PairConstructor: (Type, Type) => Type = Pair;

export type StringArray = ArrayConstructor<string>;
export type NumberArray = ArrayConstructorAlias<number>;
export type PairValue = PairConstructor<string, number>;
export type AcceptedAlias = AcceptsUnary<ArrayConstructor>;

declare const strings: StringArray;
strings.push("ok");
strings.push(1);

export type OrdinaryAlias = Array;
export type MissingApplication = ArrayConstructor;
export type KindMismatch: Type => Type = string;
export type WrongArity: (Type, Type) => Type = Array;
export type HigherOrderConstructor<T>: Type => Type = Array;




//// [higherKindedTypeAliases.d.tspp]
export interface AcceptsUnary<F: Type => Type> {
    value: F<string>;
}
export type Pair<A, B> = [A, B];
export type ArrayConstructor: Type => Type = Array;
export type ArrayConstructorAlias: Type => Type = ArrayConstructor;
export type PairConstructor: (Type, Type) => Type = Pair;
export type StringArray = ArrayConstructor<string>;
export type NumberArray = ArrayConstructorAlias<number>;
export type PairValue = PairConstructor<string, number>;
export type AcceptedAlias = AcceptsUnary<ArrayConstructor>;
export type OrdinaryAlias = Array;
export type MissingApplication = ArrayConstructor;
export type KindMismatch: Type => Type = string;
export type WrongArity: (Type, Type) => Type = Array;
export type HigherOrderConstructor<T>: Type => Type = Array;
//// [higherKindedTypeAliases.d.ts]
export interface AcceptsUnary<F> {
    value: unknown;
}
export type Pair<A, B> = [A, B];
export type ArrayConstructor<T0 = unknown> = unknown;
export type ArrayConstructorAlias<T0 = unknown> = unknown;
export type PairConstructor<T0 = unknown, T1 = unknown> = unknown;
export type StringArray = ArrayConstructor<string>;
export type NumberArray = ArrayConstructorAlias<number>;
export type PairValue = PairConstructor<string, number>;
export type AcceptedAlias = AcceptsUnary<unknown>;
export type OrdinaryAlias = Array;
export type MissingApplication = ArrayConstructor;
export type KindMismatch<T0 = unknown> = unknown;
export type WrongArity<T0 = unknown, T1 = unknown> = unknown;
export type HigherOrderConstructor<T> = unknown;
