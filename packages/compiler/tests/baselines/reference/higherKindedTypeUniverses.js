//// [tests/cases/compiler/higherKindedTypeUniverses.ts] ////

//// [higherKindedTypeUniverses.tspp]
export interface LevelZeroBox<A: Type0> {
    value: A;
}

export interface LevelOneBox<K: Type1> {
    readonly kind?: never;
}

export interface AcceptsLevelOneConstructor<F: Type1 => Type0> {
    readonly value?: never;
}

export type LegacyIdentity<A: Type> = A;
export type LevelZeroIdentity<A: Type0>: Type0 = A;
export type LevelOneIdentity<K: Type1>: Type1 = K;
export type LevelTwoIdentity<K: Type2>: Type2 = K;
export type UniverseZero: Type1 = Type0;
export type UniverseOne: Type2 = Type1;
export type ArrayThroughUniverseAlias: UniverseZero => UniverseZero = Array;
export type StringArrayThroughUniverseAlias = ArrayThroughUniverseAlias<string>;

export type ConstantAtOne<K: Type1> = string;
export type ApplyAtOne<F: Type1 => Type0, K: Type1> = F<K>;
export type AppliedConstant<K: Type1> = ApplyAtOne<ConstantAtOne, K>;

export type PreserveOne<K: Type1> = LevelOneBox<LevelOneIdentity<K>>;
export type PreserveTwo<K: Type2>: Type2 = LevelTwoIdentity<K>;
export type HugeIdentity<K: Type10000000000000000000000000000000000000000>: Type10000000000000000000000000000000000000000 = K;
export type PreserveHuge<K: Type10000000000000000000000000000000000000000>: Type10000000000000000000000000000000000000000 = HugeIdentity<K>;
export type HugeUniverse: Type10000000000000000000000000000000000000001 = Type10000000000000000000000000000000000000000;
export type BoxedUniverseZero = LevelOneBox<Type0>;

export type LegacyString = LegacyIdentity<string>;
export type LevelZeroString = LevelZeroIdentity<string>;

export type RejectStringAtOne = LevelOneBox<string>;
export type RejectOneAtZero<K: Type1> = LevelZeroBox<K>;
export type RejectZeroAtOne<K: Type0> = LevelOneBox<K>;
export type RejectWrongConstructor<F: Type0 => Type0> = AcceptsLevelOneConstructor<F>;
export type RejectUniverseAtZero = LevelZeroBox<Type0>;
export type NotAUniverse = string;
export type RejectOrdinaryKindAlias: NotAUniverse => NotAUniverse = Array;




//// [higherKindedTypeUniverses.d.tspp]
export interface LevelZeroBox<A: Type0> {
    value: A;
}
export interface LevelOneBox<K: Type1> {
    readonly kind?: never;
}
export interface AcceptsLevelOneConstructor<F: Type1 => Type0> {
    readonly value?: never;
}
export type LegacyIdentity<A: Type> = A;
export type LevelZeroIdentity<A: Type0>: Type0 = A;
export type LevelOneIdentity<K: Type1>: Type1 = K;
export type LevelTwoIdentity<K: Type2>: Type2 = K;
export type UniverseZero: Type1 = Type0;
export type UniverseOne: Type2 = Type1;
export type ArrayThroughUniverseAlias: UniverseZero => UniverseZero = Array;
export type StringArrayThroughUniverseAlias = ArrayThroughUniverseAlias<string>;
export type ConstantAtOne<K: Type1> = string;
export type ApplyAtOne<F: Type1 => Type0, K: Type1> = F<K>;
export type AppliedConstant<K: Type1> = ApplyAtOne<ConstantAtOne, K>;
export type PreserveOne<K: Type1> = LevelOneBox<LevelOneIdentity<K>>;
export type PreserveTwo<K: Type2>: Type2 = LevelTwoIdentity<K>;
export type HugeIdentity<K: Type10000000000000000000000000000000000000000>: Type10000000000000000000000000000000000000000 = K;
export type PreserveHuge<K: Type10000000000000000000000000000000000000000>: Type10000000000000000000000000000000000000000 = HugeIdentity<K>;
export type HugeUniverse: Type10000000000000000000000000000000000000001 = Type10000000000000000000000000000000000000000;
export type BoxedUniverseZero = LevelOneBox<Type0>;
export type LegacyString = LegacyIdentity<string>;
export type LevelZeroString = LevelZeroIdentity<string>;
export type RejectStringAtOne = LevelOneBox<string>;
export type RejectOneAtZero<K: Type1> = LevelZeroBox<K>;
export type RejectZeroAtOne<K: Type0> = LevelOneBox<K>;
export type RejectWrongConstructor<F: Type0 => Type0> = AcceptsLevelOneConstructor<F>;
export type RejectUniverseAtZero = LevelZeroBox<Type0>;
export type NotAUniverse = string;
export type RejectOrdinaryKindAlias: NotAUniverse => NotAUniverse = Array;
//// [higherKindedTypeUniverses.d.ts]
export interface LevelZeroBox<A> {
    value: A;
}
export interface LevelOneBox<K> {
    readonly kind?: never;
}
export interface AcceptsLevelOneConstructor<F> {
    readonly value?: never;
}
export type LegacyIdentity<A> = A;
export type LevelZeroIdentity<A> = A;
export type LevelOneIdentity<K> = K;
export type LevelTwoIdentity<K> = K;
export type UniverseZero = unknown;
export type UniverseOne = unknown;
export type ArrayThroughUniverseAlias<T0 = unknown> = unknown;
export type StringArrayThroughUniverseAlias = ArrayThroughUniverseAlias<string>;
export type ConstantAtOne<K> = string;
export type ApplyAtOne<F, K> = unknown;
export type AppliedConstant<K> = ApplyAtOne<unknown, K>;
export type PreserveOne<K> = LevelOneBox<LevelOneIdentity<K>>;
export type PreserveTwo<K> = LevelTwoIdentity<K>;
export type HugeIdentity<K> = K;
export type PreserveHuge<K> = HugeIdentity<K>;
export type HugeUniverse = unknown;
export type BoxedUniverseZero = LevelOneBox<unknown>;
export type LegacyString = LegacyIdentity<string>;
export type LevelZeroString = LevelZeroIdentity<string>;
export type RejectStringAtOne = LevelOneBox<string>;
export type RejectOneAtZero<K> = LevelZeroBox<K>;
export type RejectZeroAtOne<K> = LevelOneBox<K>;
export type RejectWrongConstructor<F> = AcceptsLevelOneConstructor<unknown>;
export type RejectUniverseAtZero = LevelZeroBox<unknown>;
export type NotAUniverse = string;
export type RejectOrdinaryKindAlias<T0 = unknown> = unknown;
