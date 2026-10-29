//// [tests/cases/compiler/mlttExtendedTypes.ts] ////

//// [mlttExtendedTypes.tspp]
export type ZeroEqualsZero: Type0 = Eq<Nat, Zero, Zero>;
export type SingletonNat: Type0 = Sigma<(value: Nat) -> Eq<Nat, value, Zero>>;

export type PathInduction: Type1 =
  (Motive: (left: Nat) -> (right: Nat) -> (proof: Eq<Nat, left, right>) -> Type0) ->
  (reflexivityCase: (value: Nat) -> Motive<value, value, Refl<Nat, value>>) ->
  (left: Nat) ->
  (right: Nat) ->
  (proof: Eq<Nat, left, right>) ->
  Motive<left, right, proof>;

export type PathInductionComputed: Type1 =
  (Motive: (left: Nat) -> (right: Nat) -> (proof: Eq<Nat, left, right>) -> Type0) ->
  (reflexivityCase: (value: Nat) -> Motive<value, value, Refl<Nat, value>>) ->
  (value: Nat) ->
  Eq<
    Motive<value, value, Refl<Nat, value>>,
    J<Nat, Motive, reflexivityCase, value, value, Refl<Nat, value>>,
    reflexivityCase<value>
  >;

export type ClosedJComputation: Type0 = Eq<
  Nat,
  J<
    Nat,
    Ann<
      Lam<(left: Nat) -> Lam<(right: Nat) -> Lam<(proof: Eq<Nat, left, right>) -> Nat>>>,
      (left: Nat) -> (right: Nat) -> (proof: Eq<Nat, left, right>) -> Type0
    >,
    Ann<Lam<(value: Nat) -> Zero>, (value: Nat) -> Nat>,
    Zero,
    Zero,
    Refl<Nat, Zero>
  >,
  Zero
>;

export type ClosedNatElim: Type0 = Eq<
  Nat,
  NatElim<
    Ann<Lam<(value: Nat) -> Nat>, (value: Nat) -> Type0>,
    Zero,
    Ann<
      Lam<(value: Nat) -> Lam<(previous: Nat) -> Succ<previous>>>,
      (value: Nat) -> (previous: Nat) -> Nat
    >,
    Succ<Zero>
  >,
  Succ<Zero>
>;

type Indexed<N extends number> = { readonly index: N };
export type BuildIndexed: Type0 = (index: Nat) -> Indexed<index>;
export declare const buildIndexed: BuildIndexed;

export const valid = buildIndexed(3);
export const negative = buildIndexed(-1);
export const fractional = buildIndexed(1.5);
export const unsafeInteger = buildIndexed(9007199254740992);
declare let dynamicNumber: number;
export const dynamic = buildIndexed(dynamicNumber);


//// [mlttExtendedTypes.js]
export const valid = buildIndexed(3);
export const negative = buildIndexed(-1);
export const fractional = buildIndexed(1.5);
export const unsafeInteger = buildIndexed(9007199254740992);
export const dynamic = buildIndexed(dynamicNumber);


//// [mlttExtendedTypes.d.tspp]
export type ZeroEqualsZero: Type0 = Eq<Nat, Zero, Zero>;
export type SingletonNat: Type0 = Sigma<(value: Nat) -> Eq<Nat, value, Zero>>;
export type PathInduction: Type1 = (Motive: (left: Nat) -> (right: Nat) -> (proof: Eq<Nat, left, right>) -> Type0) -> (reflexivityCase: (value: Nat) -> Motive<value, value, Refl<Nat, value>>) -> (left: Nat) -> (right: Nat) -> (proof: Eq<Nat, left, right>) -> Motive<left, right, proof>;
export type PathInductionComputed: Type1 = (Motive: (left: Nat) -> (right: Nat) -> (proof: Eq<Nat, left, right>) -> Type0) -> (reflexivityCase: (value: Nat) -> Motive<value, value, Refl<Nat, value>>) -> (value: Nat) -> Eq<Motive<value, value, Refl<Nat, value>>, J<Nat, Motive, reflexivityCase, value, value, Refl<Nat, value>>, reflexivityCase<value>>;
export type ClosedJComputation: Type0 = Eq<Nat, J<Nat, Ann<Lam<(left: Nat) -> Lam<(right: Nat) -> Lam<(proof: Eq<Nat, left, right>) -> Nat>>>, (left: Nat) -> (right: Nat) -> (proof: Eq<Nat, left, right>) -> Type0>, Ann<Lam<(value: Nat) -> Zero>, (value: Nat) -> Nat>, Zero, Zero, Refl<Nat, Zero>>, Zero>;
export type ClosedNatElim: Type0 = Eq<Nat, NatElim<Ann<Lam<(value: Nat) -> Nat>, (value: Nat) -> Type0>, Zero, Ann<Lam<(value: Nat) -> Lam<(previous: Nat) -> Succ<previous>>>, (value: Nat) -> (previous: Nat) -> Nat>, Succ<Zero>>, Succ<Zero>>;
type Indexed<N extends number> = {
    readonly index: N;
};
export type BuildIndexed: Type0 = (index: Nat) -> Indexed<index>;
export declare const buildIndexed: BuildIndexed;
export declare const valid: Indexed<3>;
export declare const negative: Indexed<-1>;
export declare const fractional: Indexed<1.5>;
export declare const unsafeInteger: Indexed<9007199254740992>;
export declare const dynamic: Indexed<number>;
export {};
//// [mlttExtendedTypes.d.ts]
export type ZeroEqualsZero = unknown;
export type SingletonNat = unknown;
export type PathInduction = (Motive: (left: unknown) => unknown) => unknown;
export type PathInductionComputed = (Motive: (left: unknown) => unknown) => unknown;
export type ClosedJComputation = unknown;
export type ClosedNatElim = unknown;
type Indexed<N extends number> = {
    readonly index: N;
};
export type BuildIndexed = (index: unknown) => unknown;
export declare const buildIndexed: BuildIndexed;
export declare const valid: Indexed<3>;
export declare const negative: Indexed<-1>;
export declare const fractional: Indexed<1.5>;
export declare const unsafeInteger: Indexed<9007199254740992>;
export declare const dynamic: Indexed<number>;
export {};
