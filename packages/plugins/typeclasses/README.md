# `ts-plus-plus/plugins/typeclasses`

Adds `where` constraints and typeclasses with implicit dictionary passing, as
proposed in issue 30. This is the first slice:

```ts
typeclass Eq<A, B = A> {
  equals(a: A, b: B): boolean;
}

impl NumberEq = Eq<number> {
  equals(a, b) {
    return a === b;
  }
}

function equal<A, B>(a: A, b: B) where <Eq<A, B>>: boolean {
  return Eq.equals(a, b);
}

equal(1, 2);                  // equal(NumberEq, 1, 2)
equal(@{ NumberEq }, 1, 2);   // chooses the implementation for this call
```

A `where` item is either a typeclass, which needs a dictionary, or a type
predicate, which must reduce to `true` and is erased. Dictionaries come before
ordinary parameters, in `where` order.

The search for a dictionary takes the first layer with an answer, and more than
one answer in a layer is an error:

1. the `@` context of the call;
2. the `where` clauses of the enclosing functions;
3. the `impl` declarations in scope, declared or imported.

Generic implementations are built from their own `where` clause
(`impl<T> ArrayEq = Eq<T[]> where <Eq<T>> { ... }`), and a typeclass can require
another (`typeclass Ord<A> where <Eq<A>> { ... }`), whose dictionary it then
holds in a `$Eq` field that `impl` fills in. `where` also goes on methods, function
expressions, arrow functions, function types, classes, interfaces, and type
aliases; a class stores its dictionaries when constructed, and on a type it is
only a static check. On a class or interface it comes before `extends`.

`impl<T> Option<T> { isSome(self): boolean { ... } }` gives a type inherent
methods without changing it: `option.isSome()` calls the module-level function
`Option$isSome(option)`. Only the module declaring a class or a nominal type may do
this, each method name once per type, and the methods are not part of the type for
assignment or `keyof`.

Dictionaries are decided with the checker, across files. `isolatedModules` reports
the calls that need them, and `transpileModule` refuses a file with this syntax.

A function that takes dictionaries reads them as its first arguments, so a function
without the same `where` clause cannot stand for it, in either direction.
