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
output published by `03-newtype` across a package boundary.
