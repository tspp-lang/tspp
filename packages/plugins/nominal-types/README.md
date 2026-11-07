# `ts-plus-plus/plugins/nominal-types`

An isolated syntax capsule for nominal `newtype` aliases and algebraic `data`
declarations. A newtype is assignable to its underlying type, while the
underlying type and other newtypes are not assignable back to it. A newtype
constructor lowers to an identity function and allocates nothing. It may only
be called directly (or named in `typeof`, imports, and exports): any other
value reference, such as `const make = UserId;`, reports TS18062, so the
constructor stays an erasable abstraction that never escapes into runtime
values.

Data declarations create nominal tagged unions, nullary values, typed variant
constructors, and value-level `match` expressions. Match scrutinees are
evaluated once and field bindings are inferred from positional variant data.
Matches must cover every constructor unless they include a `_` fallback, and
constructor patterns must bind exactly the declared number of fields. Branches
may use `if` guards, nullary constructors can be combined with `|`, and nested
constructors use forms such as `Wrapped(Some(value))` or `Wrapped(None())`.

Ordinary, generic, and exported declarations are supported. Declaration emit
keeps the `newtype` and `data` syntax so downstream TS++ projects retain the
same semantics.
