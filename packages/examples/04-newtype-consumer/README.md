# Cross-package newtype consumer

This package consumes the `newtype` declaration emitted by
`@tspp/example-newtype`. The plugin erases both its identity constructor call
and the now type-only package import from JavaScript output.

Build the producer first, then run `pnpm build` in this package.
