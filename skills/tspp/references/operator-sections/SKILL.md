---
name: tspp-operator-sections
description: Write or troubleshoot TS++ underscore sections for operators, properties, and methods.
---

# Operator Sections

Use in `.tspp` files. Enable `{ "name": "ts-plus-plus/plugins/operator-sections", "tspp": true }` in `compilerOptions.plugins` of the project's `tsppconfig.json`.

`(_ + 1)` is equivalent to a single-parameter function. `(10 - _)` preserves operand order; the two parameters of `(_ / _)` follow placeholder order from left to right. Compound expressions, `(_.name)`, and `(_.trim())` are supported, as are direct forms such as `numbers.filter(_ > 1).map(_ * 2)`. Contextual typing determines parameter types; annotate the function type when context is missing.

`_` can also be an existing identifier; avoid mixing variable bindings with placeholders. Consult the [implementation](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/plugins/operator-sections/src/sections.ts) and [tests](https://github.com/tspp-lang/tspp/tree/v0.1.1/packages/plugins/operator-sections/test) for binding rules and boundaries, and the [examples](https://github.com/tspp-lang/tspp/tree/v0.1.1/packages/examples/02-operator-sections) for further usage.
