# `@tspp/plugin-higher-kinded-types`

Adds kind annotations such as `F: Type => Type`, first-class references to generic aliases and interfaces, and application of higher-kinded parameters through normal type-reference syntax. `Type` is the ordinary `Type0` kind, and the non-cumulative universe hierarchy treats `TypeN` itself as a value of kind `Type(N+1)`.
