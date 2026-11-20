---
name: tspp-nominal-types
description: Write or troubleshoot TS++ newtype and data declarations and value-level match patterns.
---

# Nominal Types and Algebraic Data

Enable `ts-plus-plus/plugins/nominal-types` and follow the project's existing export and call conventions.

```ts
newtype UserId = string;
const id: UserId = UserId("user-1");
const raw: string = id;

data Maybe<T> = None | Some(value: T);
const option: Maybe<number> = Some(42);
const value = match option { Some(x) => x, None => 0 };
```

A `newtype` is assignable to its underlying type; the reverse and assignments between distinct newtypes are rejected. Its constructor lowers to an allocation-free identity function and may only be called directly or used in `typeof`, imports, and exports. Do not store it as an ordinary function value. The underlying type cannot be `any`, `unknown`, or `never`.

`data` produces a nominal tagged union; nullary variants are values. `match` evaluates its scrutinee once, and constructor patterns must bind the correct number of fields. Cover every variant or use `_`; guarded branches alone do not establish coverage. Nested patterns and `|` combinations of nullary variants are supported. Declaration emit preserves this syntax for downstream TS++ projects. Consult the [plugin documentation](../README.md) and [examples](../../../examples/05-nominal-types/src/01-basics.tspp), then use the project's TS++ build to check types and exhaustiveness.

Indexed declarations use brace bodies of constructor signatures, for example `data Expr<T> { Val: (value: bigint) => Expr<bigint>, Flag: (value: boolean) => Expr<boolean>, }`. Constructors may introduce their own parameters: `data SomeExpr { Some: <T>(expression: Expr<T>) => SomeExpr, }`. A direct result type defines a nullary value; a function type defines a callable constructor, including zero-argument generic forms such as `Stop: <T>() => Witness<T>`. The earlier `data D<T> = A(...): D<T> | ...;` indexed form remains compatible. Use ordinary constructors to create dependent pairs and ordinary `match` to open them; there are no `pack`/`unpack` keywords. Match arms receive local index equations and fresh hidden types. Do not let hidden types escape without repackaging them, assume two independently hidden types coincide, or invert arbitrary structural aliases. Use strict function checking for invariant indices. See the dependent-type interpreter examples for checked type-family return values and context indices.

Prefer a complete expression annotation to repeated constructor type arguments: an expected indexed result flows into nested constructors and callbacks, and sibling indexed arguments help type operator callbacks. Annotate ambiguous local definitions or supply explicit type arguments when needed. Inference does not look ahead to later statements or invert arbitrary type families. The context interpreter's `add` needs only its full `Expr` annotation; its factorial uses one typed local expression and an explicit context on the recursive call.
