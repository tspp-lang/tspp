---
name: tspp-modern-syntax
description: Write or troubleshoot TS++ let-in expressions, do blocks, use trailing closures, and deeply readonly def bindings.
---

# Modern Value Syntax

Use in `.tspp` files. Enable `{ "name": "ts-plus-plus/plugins/modern-syntax", "tspp": true }` in `compilerOptions.plugins` of the project's `tsppconfig.json`.

- `let a = 20, b = 22 in a + b` is a local binding expression.
- `do { const a = 1; a + 2; }` uses its completion value as the expression result. Functions and methods can also have a `do` body, such as `function f(): number do { 42; }`; its result must match the return type.
- Place `use x <- withValue(40);` directly inside a `do` completion block to pass the remaining statements as a trailing callback. The called function controls when and how often that callback runs.
- `def data = { inner: { value: 1 }, items: [10, 20] };` preserves literal types and enforces deep readonly checks. It emits an ordinary `const`; it does not freeze values at runtime.

Consult the [examples](https://github.com/tspp-lang/tspp/tree/v0.1.1/packages/examples/01-modern-syntax) for branching, continuations, and error boundaries, and the [plugin tests](https://github.com/tspp-lang/tspp/tree/v0.1.1/packages/plugins/modern-syntax/test) for exact parsing and emit behavior.
