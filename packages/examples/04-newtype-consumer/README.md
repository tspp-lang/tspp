# Cross-package newtype consumer

This package consumes the `newtype` declaration emitted by
`@tspp/example-newtype`. The plugin erases both its identity constructor call
and the now type-only package import from JavaScript output.

The example also contains compile-time assertions proving that erased
constructors cannot escape as first-class runtime values and accept exactly one
argument.

Source lives in `src/` and build output goes to `dist/`. Build the producer
first, then run `pnpm build` in this package.
