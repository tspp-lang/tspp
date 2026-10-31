# TS++ examples

This directory is the workspace opened by the VSCode Extension Development
Host. It is only a container, not a package. Each numbered child directory is
an independent pnpm workspace package with its own dependencies and compiler
configuration.

This keeps every example's capability set isolated from the others.

Every example keeps authored code under `src/`. Packages that emit JavaScript
or declarations write generated files to `dist/`; package roots contain only
configuration, metadata, and documentation.

`04-newtype-consumer` additionally demonstrates consuming the declaration
output published by `03-nominal-types` across a package boundary.

## Learning path

| Package | Main capability |
| --- | --- |
| `01-modern-syntax` | value-level `let`, completion blocks, `use`, and `def` |
| `02-formal-verification` | proof points, contracts, refinements, and SMT |
| `03-nominal-types` | newtypes, algebraic data, and exhaustive matching |
| `04-newtype-consumer` | preserving nominal identity across packages |
| `05-dependent-types` | universes, Pi/Sigma, equality, and reification |
| `06-type-computation` | local bindings, type matching, and type lambdas |
| `07-higher-kinded-types` | first-class constructors and universe kinds |
| `08-static-interface-members` | static and instance contracts together |
| `09-typescript-interop` | dual declarations and the one-way source boundary |
| `10-macros` | synchronous, asynchronous, recursive, and bounded macros |

Examples migrated from the pre-plugin implementation are adapted to use the
smallest useful capsule set. They are not allowed to rely on a repository-wide
feature switch.
