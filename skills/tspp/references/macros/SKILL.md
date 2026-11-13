---
name: tspp-macros
description: Write or troubleshoot TS++ compile-time macros, AST generation, asynchronous expansion, and execution timeouts.
---

# Compile-Time Macros

Use in `.tspp` files. Enable `{ "name": "ts-plus-plus/plugins/macros", "tspp": true }` in `compilerOptions.plugins` of the project's `tsppconfig.json`. Macros execute during compilation, and their definitions are erased from runtime output. Run only trusted macro code.

```ts
import type { MacroContext, MacroReturn, MacroTarget } from "ts-plus-plus/plugins/macros/sdk";
export macro function requireFunction([target]: readonly MacroTarget[], context: MacroContext): MacroReturn {
  return target.node.kind === context.typescript.SyntaxKind.FunctionDeclaration
    ? undefined : context.fail(`${target.name} must be a function declaration`);
}
function answer(): number { return 42; }
macro requireFunction(answer);
```

Macros receive an array of target declarations and a context. They may return no value, a statement, an array of statements, or a failure result. `context.report` reports diagnostics; `context.fail` constructs a failure result. `context.factory` and `context.typescript.factory` provide node factories. Generated statements participate in type checking, and generated macro calls expand recursively. Declare asynchronous macros with `export async macro(...) function`; invocation still uses `macro name(...)`.

The only supported option is `timeout`: use a fixed budget such as `{ timeout: { type: "fixed", value: 2, unit: "s" } }` (also supports `ms`), or `{ timeout: { type: "benchmark", multiplier: 2 } }`. Values must be positive. Consult the [SDK contract](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/plugins/macros/src/sdk.ts), [option parser](https://github.com/tspp-lang/tspp/blob/v0.1.1/packages/plugins/macros/src/options.ts), and [validation, generation, recursion, and async examples](https://github.com/tspp-lang/tspp/tree/v0.1.1/packages/examples/13-macros).
