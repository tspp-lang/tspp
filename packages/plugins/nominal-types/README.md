# `@tspp/plugin-nominal-types`

An isolated syntax capsule for nominal `newtype` aliases and algebraic `data`
declarations. A newtype is assignable to its underlying type, while the
underlying type and other newtypes are not assignable back to it. Constructor
calls are erased to their argument, so the abstraction has no runtime
allocation or call cost.

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
