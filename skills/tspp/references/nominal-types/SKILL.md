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

`data` produces a nominal tagged union; nullary variants are values. `match` evaluates its scrutinee once, and constructor patterns must bind the correct number of fields. Cover every variant or use `_`; guarded branches alone do not establish coverage. Nested patterns and `|` combinations of nullary variants are supported. Declaration emit preserves this syntax for downstream TS++ projects. Consult the [plugin documentation](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/plugins/nominal-types/README.md) and [examples](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/examples/05-nominal-types/src/01-basics.tspp), then use the project's TS++ build to check types and exhaustiveness.
