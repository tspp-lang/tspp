---
name: tspp-typeclasses
description: Write or troubleshoot TS++ typeclass and impl declarations, where constraints, and inherent methods.
---

# Typeclasses

Enable `ts-plus-plus/plugins/typeclasses`. Use a full TS++ program build to check dictionary resolution across files.

```ts
typeclass Eq<A, B = A> { equals(a: A, b: B): boolean; }
impl NumberEq = Eq<number> { equals(a, b) { return a === b; } }
function equal<A, B>(a: A, b: B) where <Eq<A, B>>: boolean {
    return Eq.equals(a, b);
}
equal(1, 2);
equal(@{ NumberEq }, 1, 2);
```

Dictionary search proceeds through the call's `@` context, enclosing functions' `where` clauses, and implementations declared or imported into scope. Multiple candidates in the first layer with an answer cause an ambiguity error. Generic implementations may have their own `where` clauses, and typeclasses may depend on other typeclasses. Type-predicate constraints must reduce to `true` and are erased at runtime. Dictionaries precede ordinary parameters in `where` order; functions with different dictionary requirements are not interchangeable. `isolatedModules` reports calls requiring cross-file dictionaries, and single-file `transpileModule` does not support this syntax.

`impl<T> Box<T> { ... }` adds inherent methods to a class or nominal type declared in the same module. These methods do not participate in structural assignability or `keyof`, and each method name may be defined only once per type. Consult the [plugin documentation](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/plugins/typeclasses/README.md) and [examples](https://github.com/tspp-lang/tspp/tree/v0.1.1/packages/examples/07-typeclasses).
