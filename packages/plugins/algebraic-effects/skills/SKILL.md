---
name: tspp-algebraic-effects
description: Write or troubleshoot TS++ effect declarations, perform expressions, handlers, and suspend continuations.
---

# Algebraic Effects

Use in `.tspp` files. Enable `{ "name": "ts-plus-plus/plugins/algebraic-effects", "tspp": true }` in `compilerOptions.plugins` of the project's `tsppconfig.json`.

```ts
effect Logger { info(message: string): void; }
function run() / Logger: number {
  perform Logger.info("running");
  return 42;
}
const result = handle Logger {
  info(message) { console.log(message); },
} in { run(); };
```

Effect clauses appear between parameters and the return type on functions, methods, and function types: `/ E` or `/ { A, B }`. `perform` uses the nearest handler or a capability listed by the function. Generic handlers use `handle State<number>`. The handler block's final expression supplies its result; a `return` clause can map that result. Ordinary arrows and function expressions capture surrounding capabilities; unannotated function declarations and methods do not. Effectful and ordinary functions are not interchangeable.

A `handle` block cannot directly use `return`, `await`, or `yield`. Effect inference and effect polymorphism are not supported. Constructors and accessors cannot carry effect clauses. For `suspend`/`control`, declaration emit, or cross-file calls, consult the [complete rules](../README.md) and [examples](../../../examples/11-algebraic-effects).

Suspend operations require `control` handlers. A continuation may be settled only once through `k.resume(value)` or `k.abort(error)`; a `handle` with `control` returns a `Promise`. Listing an effect with a `suspend` operation compiles the function as a generator. Async functions and generators cannot list such effects. Ordinary callbacks cannot suspend directly; use a loop or an explicitly annotated function.
