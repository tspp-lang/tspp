# Let-in expression

This isolated example package demonstrates the
`@tspp/plugin-let-in-expression` syntax capsule:

```tspp
const total = let left = 20, right = 22 in left + right;
```

Its package manifest declares only the compiler and plugin needed by this
example. Future examples should follow the same one-package-per-capability-set
boundary.
