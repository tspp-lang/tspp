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
- `class C extends A, B` inherits from several bases. Constructor arguments and `super` go to the first base; `instanceof`, private fields, and static fields of later bases work on `C`. Two bases with a member of the same name are an error even if `C` overrides it, and abstract members of later bases must be implemented. A later base must be a top-level class of a `.tspp` file in the same compilation, with no constructor parameters, no base of its own, and no static private members.

For inheritance, declaration emit, and generated-method details, consult the [plugin tests](https://github.com/tspp-lang/tspp/tree/v0.1.2/packages/plugins/advanced-classes/test) and [complete examples](https://github.com/tspp-lang/tspp/tree/v0.1.2/packages/examples/03-advanced-classes).
