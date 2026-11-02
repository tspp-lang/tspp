# `@tspp/plugin-operator-sections`

Adds placeholder-based operator sections such as `(_ + 1)`, `(_ + _)`, and
`values.map(_ * 2)`. The plugin desugars them while parsing, through the
compiler's generic syntax extension positions for primary expressions and call
arguments, into arrow functions with one parameter per placeholder.
