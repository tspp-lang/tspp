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

`class C extends A, B` makes `C` a subclass of every direct base. Supply a separate argument tuple for each base:

```typescript
class A {
  constructor(public x: number, public offset: number) {}
  foo(): number { return this.x + this.offset; }
}
class B {
  constructor(public label: string, public enabled: boolean) {}
  bar(): string { return this.enabled ? this.label : ""; }
}
class C extends A, B {
  constructor(x: number, y: string) {
    super({ B: [y, true], A: [x, 10] });
  }
  run() { return [super[A].foo(), super[B].bar()]; }
}
```

Every direct base must occur exactly once, including `Base: []` for a constructor without arguments. Missing, unknown,
duplicate, spread, non-array, and tuple-hole entries are errors (19126). TypeScript checks each base's overloads,
required arguments, generic substitutions, and contextual argument types. The call must be one direct constructor
statement; conditional or repeated super calls are unsupported.

All supplied argument expressions run once, in property order, before any base initializes. Constructors then run in
that same property order, independently of the `extends` order, on one shared object. Fields, parameter properties,
default/rest/destructured parameters, private state, and constructor `new.target` follow that base's initialization
turn. Every base's nominal `instanceof` identity is already visible before any initializer; private fields and methods
become available according to the configured field/parameter ordering. Field/default ordering follows the configured TypeScript target and `useDefineForClassFields`. A thrown argument
prevents every constructor; a thrown initializer prevents later bases. Nested and reentrant construction use their own
argument packets.

Use the spelling from `extends`: `Base: [...]` for an identifier (including a renamed import), or
`[module.Base]: [...]` for a qualified name or names that collide. `super[Base].method()` selects that base's prototype;
reads also support accessors, with the current instance as receiver. Static qualified super uses the current derived
constructor as receiver. Member types come from the selected base, so polymorphic `this` results are typed as that base.
Parenthesized calls retain the receiver; detached method reads remain unbound. Alternate import
aliases that were not written in `extends` are rejected, so instantiated generic arguments remain intact. Unqualified
`super.member`, writes, updates, deletion, tagged templates, optional calls, dynamic member names, and instance/arrow
field selection are unsupported (19127). Ordinary single inheritance keeps its normal `super` behavior.

Mapped construction copies every direct base, so all of them must be named top-level classes in `.tspp` files of this
compilation, with no own base, decorators, computed member names, static private members, private accessors, or
auto-accessors (19121). Copied constructors may take parameters, but cannot return a value, reference lexical
`arguments`, or call direct `eval`. Private optional accesses, private tagged templates, and private destructuring writes
also remain unsupported. These restrictions leave ordinary classes unchanged when nobody copies them.

Classes without a constructor and legacy `super(args)` remain supported: arguments go to the first base, then additional
bases initialize with no supplied arguments. An additional base requiring arguments needs mapped construction. This
legacy path permits an external or otherwise ordinary first base; mapped construction requires every base to be eligible.
The compiler emits factory copies only for classes that are actually copied. Static fields are shared with the original.
A newly copied base must be recompiled together with its users; stale incremental output throws a named `TypeError`.

A member provided by two bases remains an error (19122), even if the derived class declares it. Private names do not
conflict. Concrete classes must implement abstract members from additional bases (19123); duplicate base identities
are rejected (19124), and `final`/`sealed` checks apply to every base. The checker combines the first instance base with
a merged interface for the remaining ones and all static sides; compatible `.d.ts` output works without the plugin.

Prototype reflection on these copied classes is restricted (19125): direct `.prototype` on `C`, an additional base, or
their subclasses; `.__proto__` on those constructors or instances; and the inherited reflective `.constructor` on their
instances, including object destructuring declarations and assignments. The checker also rejects the built-in
`Object`/`Reflect.getPrototypeOf` and `setPrototypeOf`, `Object.create`,
and `Object.prototype.isPrototypeOf` calls when a relevant target, prototype, receiver, or argument has one of those
types. It also checks the same restricted property names in built-in `Reflect.get`, `set`, `has`, `deleteProperty`,
`defineProperty`, `getOwnPropertyDescriptor`, and `Object.getOwnPropertyDescriptor` and `defineProperty` calls. Literal and statically known
string-key access, inferred value aliases, union and intersection types, and generic constraints are checked when
the class identity remains available; API aliases are followed through `const` initializers and object destructuring.
An explicitly declared ordinary `constructor` member is allowed. Every mapped base is affected; a legacy first base
remains unrestricted unless it is copied independently.

These checks rely on static types within the compilation. Values widened to `any`, `object`, or an unrelated external
type are not tracked; dynamic property names, indirect wrappers and arbitrary data flow are not analyzed. Normal
construction, members, `instanceof`, `Object.keys`, and object spread remain available. Replacing static methods at
run time can diverge between copies and is not checked.
