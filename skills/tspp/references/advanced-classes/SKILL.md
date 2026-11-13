---
name: tspp-advanced-classes
description: Write or troubleshoot TS++ data classes, singletons, sealed hierarchies, final members, and field accessors.
---

# Advanced Classes

Use in `.tspp` files. Enable `{ "name": "ts-plus-plus/plugins/advanced-classes", "tspp": true }` in `compilerOptions.plugins` of the project's `tsppconfig.json`. Preserve existing configuration and add the plugin only when needed.

- `data class Point(x: number, y: number)` creates properties from primary constructor parameters and generates `copy`, `equals`, and `toString`. Use `p.copy({ y: 5 })` or `with(p, { y: 5 })` to create a copy; property updates are type-checked.
- `object Origin { ... }` declares a singleton. `Origin` is available as both a value and a type.
- `field count: number = 0 { get() { return field; } set(v) { field = v; } }` uses implicit backing storage inside its accessors. `field` is available only within the corresponding accessors.
- A `sealed` class allows subclasses only in the same source file. `final class` prohibits inheritance, and a `final` method prohibits overriding.

For inheritance, declaration emit, and generated-method details, consult the [plugin tests](https://github.com/tspp-lang/tspp/tree/v0.1.2/packages/plugins/advanced-classes/test) and [complete examples](https://github.com/tspp-lang/tspp/tree/v0.1.2/packages/examples/03-advanced-classes).
