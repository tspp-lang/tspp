# Formal verification

This package enables `@tspp/plugin-formal-verification`. Run `pnpm check` to
send the two closed arithmetic proof points through the plugin-owned Z3 worker.
The same package also demonstrates symbolic function pre/postconditions and
loop-invariant initialization/preservation. Change an assertion, postcondition,
or invariant to see a verification diagnostic in both the CLI and the VS Code
development host.

The independent `@tspp/plugin-let-in-expression` capsule is enabled alongside
it. This keeps a real multi-plugin project in the test path without coupling
either feature package to the other.

The example source is `src/index.tspp`.
