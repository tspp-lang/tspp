//// [tests/cases/compiler/higherKindedTypesBasic.ts] ////

//// [higherKindedTypesBasic.tspp]
export interface Apply<F: Type => Type, A> {
    value: F<A>;
}

export interface Apply2<F: (Type, Type) => Type, A, B> {
    value: F<A, B>;
}

export type Pair<A, B> = [A, B];
export type AliasApply<F: Type => Type, A> = F<A>;

export interface Functor<F: Type => Type> {
    map<A, B>(fa: F<A>, fn: (value: A) => B): F<B>;
}

export type ArrayOfString = Apply<Array, string>;
export type AliasArrayOfString = AliasApply<Array, string>;
export type PairOfStringAndNumber = Apply2<Pair, string, number>;

declare const applied: Apply<Array, string>;
applied.value.push("ok");
applied.value.push(1);

declare const pair: Apply2<Pair, string, number>;
pair.value[0].toUpperCase();
pair.value[1].toFixed();

declare const arrayFunctor: Functor<Array>;
const mapped = arrayFunctor.map([1, 2, 3], value => value.toString());
mapped.push("ok");
mapped.push(1);

declare function unwrap<F: Type => Type, A>(value: F<A>): A;
const unwrapped = unwrap<Array, string>(["value"]);
unwrapped.toUpperCase();

export type Invalid = Apply<string, string>;
export type WrongArity = Apply<Pair, string>;




//// [higherKindedTypesBasic.d.tspp]
export interface Apply<F: Type => Type, A> {
    value: F<A>;
}
export interface Apply2<F: (Type, Type) => Type, A, B> {
    value: F<A, B>;
}
export type Pair<A, B> = [A, B];
export type AliasApply<F: Type => Type, A> = F<A>;
export interface Functor<F: Type => Type> {
    map<A, B>(fa: F<A>, fn: (value: A) => B): F<B>;
}
export type ArrayOfString = Apply<Array, string>;
export type AliasArrayOfString = AliasApply<Array, string>;
export type PairOfStringAndNumber = Apply2<Pair, string, number>;
export type Invalid = Apply<string, string>;
export type WrongArity = Apply<Pair, string>;
//// [higherKindedTypesBasic.d.ts]
export interface Apply<F, A> {
    value: unknown;
}
export interface Apply2<F, A, B> {
    value: unknown;
}
export type Pair<A, B> = [A, B];
export type AliasApply<F, A> = unknown;
export interface Functor<F> {
    map<A, B>(fa: unknown, fn: (value: A) => B): unknown;
}
export type ArrayOfString = Apply<unknown, string>;
export type AliasArrayOfString = AliasApply<unknown, string>;
export type PairOfStringAndNumber = Apply2<unknown, string, number>;
export type Invalid = Apply<string, string>;
export type WrongArity = Apply<unknown, string>;
