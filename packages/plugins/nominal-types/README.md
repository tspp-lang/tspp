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
constructors, and value-level `match` expressions. Constructor fields may not use
`_tag` or `_values`, which are reserved for the data representation. Reading these
properties and using the same names in ordinary objects remain supported. Match scrutinees are
evaluated once and field bindings are inferred from positional variant data.
Matches must cover every constructor unless they include a `_` fallback, and
constructor patterns must bind exactly the declared number of fields. Branches
may use `if` guards, nullary constructors can be combined with `|`, and nested
constructors use forms such as `Wrapped(Some(value))` or `Wrapped(None())`.

Ordinary, generic, and exported declarations are supported. Declaration emit
keeps the `newtype` and `data` syntax so downstream TS++ projects retain the
same semantics.

## Indexed constructors and dependent matches

An indexed declaration gives every constructor its own result type. Constructors
may declare their own type parameters, including parameters hidden by the result:

```ts
data Expr<T extends "int" | "bool"> {
  Val: (value: bigint) => Expr<"int">,
  Flag: (value: boolean) => Expr<"bool">,
}

data SomeExpr {
  Some: <T extends "int" | "bool">(expression: Expr<T>) => SomeExpr,
}

function choose(flag: boolean): SomeExpr {
  return flag ? Some(Val(42n)) : Some(Flag(true));
}

function evaluate<T extends "int" | "bool">(expression: Expr<T>):
  T extends "int" ? bigint : boolean {
  return match expression {
    Val(value) => value,
    Flag(value) => value
  };
}

data SomeValue {
  Evaluated: <T extends "int" | "bool">(
    expression: Expr<T>, value: T extends "int" ? bigint : boolean
  ) => SomeValue,
}

const result = match choose(true) {
  Some(expression) => Evaluated(expression, evaluate(expression))
};
```

`match` checks each arm using the equations supplied by its constructor's
result indices. These equations are local to the arm. Constructor parameters
not determined by the matched indices become fresh, rigid types: two independent
matches do not establish that their hidden indices are equal. A result which
still mentions a hidden type must be wrapped in a user-defined data constructor
or consumed through an interface which hides that type. Two kinds of result
may leave the arm as a known type instead, because that is a supertype of what
the arm computed: a value index, a hidden type constrained to primitives such
as `N extends number` in `Sized: <N extends number>(length: N, items: Vec<N>)`,
becomes its constraint, so `Sized(length, items) => length` is a `number`; and a
hidden type intersected with a known one, as runtime evidence refines a value to
`A & number`, is that known type. No `pack` or `unpack` keyword is needed. Direct reads of existential constructor fields expose
`unknown`; match the value to obtain their correlated types.

Indexed type arguments are invariant in strict function checking. Use `strict`
or `strictFunctionTypes` for indexed programs, as for other APIs relying on
function variance. Every indexed constructor must return its declaring data
type with all indices supplied. A nongeneric nullary constructor remains a value;
a constructor declaring type parameters is a function, including when it has no
fields. `_tag` and `_values` are reserved field names.

Brace declarations list named constructor signatures separated by commas. A
function type declares a constructor function; a direct result type declares a
nullary value, for example `Nil: Env<readonly []>`. Generic zero-argument
constructors use function types such as `Stop: <T>() => Witness<T>`. The earlier
`data D<T> = A(...): D<T> | ...;` indexed syntax remains supported for compatibility.

An expected result type supplies constructor indices to nested constructor calls
and callbacks. Sibling arguments also contribute their indexed types, so operator
callbacks can obtain their parameter types from their expression arguments. For
example, the interpreter's annotated `add` uses `Lam(Lam(Op(..., Var(Stop()),
Var(Pop(Stop())))))` without constructor type arguments. Keep an annotation on a
local value when its definition would otherwise be ambiguous. Inference uses the
current expression's expected type; it does not look ahead to later assignments
or recover an index by inverting a noninjective type family. Explicit constructor
type arguments remain available for cases without enough information.

Exhaustiveness omits constructors whose indices are provably incompatible,
including nested patterns. Ordinary structural type aliases are not assumed
injective: an alias may discard an argument. Unresolved type functions and
arithmetic equations require more explicit evidence; matching does not invert
arbitrary TypeScript types or prove arbitrary theorems. Runtime string comparisons
do not introduce dependent equations; use indexed witness constructors and
`match` when runtime type inspection must refine other values.

See [the type-indexed interpreter](../../examples/10-dependent-types/src/10-gadt-interpreter.tspp)
and [the context-indexed interpreter](../../examples/10-dependent-types/src/11-context-interpreter.tspp)
for dynamic result pairs, variables, lambdas, and explicitly delayed recursion.
The [standalone interpreter](../../examples/10-dependent-types/src/12-well-typed-interpreter.tspp)
combines these features in one runnable file.
