# `ts-plus-plus/plugins/advanced-classes`

TS++ Advanced Classes plugin providing modern OOP features:
- `object` declarations (first-class singletons)
- `final` classes and methods
- `sealed` classes (Kotlin-style same-file closed hierarchy)
- `field` implicit backing property syntax
- `data class` with auto-synthesized `copy`, `equals`, `toString`
- `with` copy expressions
- multiple inheritance: `class C extends A, B`

## Multiple inheritance

`class C extends A, B, D` makes `C` a subclass of every base. The first base is an ordinary parent: constructor arguments
go to it and `super` refers to it. Each later base is copied onto the chain at run time, `D` on `B` on `A`, and each copy
shares the original class's private fields, static fields, and `instanceof`.

- The checker sees `C` as a class extending a constant typed as `A` with the static sides of the other bases, merged with
  an interface `C` that extends `B` and `D`. Compatible `.d.ts` output keeps those three declarations, so projects without
  the plugin read the same types.
- A member that two bases provide is an error (19122), even when `C` declares it too; private names (`#x`) never
  conflict. Abstract members of an additional base must be implemented unless `C` is abstract (19123). A base listed
  twice is an error (19124), and `final` and `sealed` apply to every base.
- Every base after the first must be a class declared at the top level of a `.tspp` source file of the same compilation,
  without a base of its own, constructor parameters, decorators, static private members, private accessors,
  auto-accessors, or private members read through optional chaining, tagged templates, or destructuring (19121). The
  compiler finds these classes itself: only a class that some class uses as an additional base is emitted as a factory
  of copies, and every other class is emitted as written.
- Because the factory is decided per compilation, a class from another package or a referenced project cannot be an
  additional base. In an incremental build, a file that starts using a class as an additional base needs the class's own
  file compiled again; until then the program throws a `TypeError` that names the class.
- Each base must be a name, such as `Base` or `module.Base` (19120). Static fields of a copy read and write the
  original's, and `super` reaches only the first base.

