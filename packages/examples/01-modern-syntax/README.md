# Modern syntax

This isolated example package demonstrates the
`@tspp/plugin-modern-syntax` capsule:

```tspp
const total = let left = 20, right = 22 in left + right;

const greeting = do {
  const name = "TS++";
  `Hello from ${name}`;
};

function add(left: number, right: number): number do {
  left + right;
}

const answer = do {
  use value <- withValue(42);
  value;
};

def config = {
  server: { port: 8080 },
  tags: ["compiler", "plugin"],
};
```

Its package manifest declares only the compiler and plugin needed by this
example. The feature owns expression parsing, completion-valued function
bodies, trailing-closure bindings, deep-readonly declarations,
implicit-return lowering, and editor grammar contributions.

The `compilerOptions.plugins` entry in `tsconfig.json` is the executable
capability declaration. Both the TS++ compiler and tsserver load the same
feature package from it.

The example source is `src/index.tspp`.
