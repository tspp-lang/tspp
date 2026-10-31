# Cross-package nominal types consumer

This package consumes `newtype` and `data` declarations emitted by
`@tspp/example-nominal-types`. It verifies that nominal aliases, constructors,
and value matching retain their semantics through generated declarations.

The example also contains compile-time assertions proving that erased
constructors cannot escape as first-class runtime values and accept exactly one
argument.

Source lives in `src/` and build output goes to `dist/`. Build the producer
first, then run `pnpm build` in this package.
