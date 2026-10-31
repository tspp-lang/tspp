# TS++ examples

This directory is the workspace opened by the VSCode Extension Development
Host. The root is the only pnpm workspace package and owns the shared compiler
dependency. Each numbered child directory is an isolated example project with
its own package manifest and compiler configuration.

The root package aggregates commands across those projects without merging
their feature configurations.
