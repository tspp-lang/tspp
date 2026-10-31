# Let-in expression

This isolated example package demonstrates the
`@tspp/plugin-let-in-expression` syntax capsule:

```tspp
const total = let left = 20, right = 22 in left + right;
```

The shared examples workspace supplies the compiler. This project keeps its own
manifest and compiler configuration so future examples can select a different
capability set without merging their settings.
