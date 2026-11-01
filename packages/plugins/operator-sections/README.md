# `@tspp/plugin-operator-sections`

Adds placeholder-based operator sections such as `(_ + 1)`, `(_ + _)`, and
`values.map(_ * 2)`. The plugin owns activation and editor grammar; the compiler
only exposes the generic placeholder-expression registration seam.
