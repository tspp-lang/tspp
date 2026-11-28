---
name: tspp-advanced-classes
description: Write or troubleshoot TS++ data classes, singletons, sealed hierarchies, final members, field accessors, and multiple inheritance.
---

# Advanced Classes

Use in `.tspp` files. Enable `{ "name": "ts-plus-plus/plugins/advanced-classes", "tspp": true }` in `compilerOptions.plugins` of the project's `tsppconfig.json`. Preserve existing configuration and add the plugin only when needed.

- `data class Point(x: number, y: number)` creates properties from primary constructor parameters and generates `copy`, `equals`, and `toString`. Use `p.copy({ y: 5 })` or `with(p, { y: 5 })` to create a copy; property updates are type-checked.
- `object Origin { ... }` declares a singleton. `Origin` is available as both a value and a type.
- `field count: number = 0 { get() { return field; } set(v) { field = v; } }` uses implicit backing storage inside its accessors. `field` is available only within the corresponding accessors.
- A `sealed` class allows subclasses only in the same source file. `final class` prohibits inheritance, and a `final` method prohibits overriding.
- `class C extends A, B` inherits from several bases. Use `super({ A: [x], B: [y] })` with every direct base exactly once (`[]` for no arguments). All argument expressions evaluate once before constructors run in the map's written order, on the same object. Select methods/accessors with `super[A].member`; ordinary unqualified `super.member` is rejected in multiple inheritance. Use the exact spelling from `extends`, including renamed imports and computed `[ns.Base]` keys. All mapped bases must be top-level `.tspp` classes of this compilation without their own base, computed member names, decorators, static private members, or private accessors. Copied constructors support parameters/defaults/rest/parameter properties, but reject value returns, lexical `arguments`, and direct `eval`. Legacy no-constructor classes and `super(args)` send arguments to the first base and initialize later bases with no arguments; the legacy first base may be external. Private state, static fields, and `instanceof` are shared. Duplicate member names remain errors and concrete classes must implement abstract members. See the plugin README for qualified-super restrictions and prototype-operation diagnostic 19125.

For inheritance, declaration emit, and generated-method details, consult the [plugin tests](https://github.com/tspp-lang/tspp/tree/v0.2.0/packages/plugins/advanced-classes/test) and [complete examples](https://github.com/tspp-lang/tspp/tree/v0.2.0/packages/examples/03-advanced-classes).
