# `@tspp/plugin-formal-verification`

An isolated formal-verification capsule. The package owns proof-point discovery,
SMT lowering, the resource-limited Z3 worker, and feature diagnostics. Core TSPP
only schedules the generic program analyzer declared by the plugin SDK.

The capsule supports closed and local `assert:` proof points, trusted `assume:`
facts, symbolic function `requires`/`ensures`, direct-call precondition checks,
verified call summaries, branch-sensitive return paths, and integer loop
invariants. Each invariant produces separate initialization and one-step
preservation obligations.

Refinement aliases such as `type Positive = bigint with { predicate: value >
0n; };` are erased from JavaScript. Their predicates are proved at introduction
and return sites and propagated from refined parameters. Runtime bigint `/` and
`%` use JavaScript's truncation-toward-zero semantics; variable divisors create
an explicit nonzero proof obligation.

`number` is never silently treated as mathematical arithmetic. A function must
select `numberModel: "mathematical-real"` or `numberModel: "safe-integer"`.
The latter constrains parameters to JavaScript's exact integer range and emits
range obligations for executed addition, subtraction, and multiplication.

Classes take the same clauses. A class header's `with { invariant: ...; }`
states a condition over private or readonly fields that every constructor must
establish and every instance method must preserve, on each `return`, on falling
off the end, and when it throws; `numberModel` there applies to the fields and
every member. Constructors and methods take `requires`/`ensures` like functions,
and `ensures` may read `this.field`. The analyzer asks the host for the
checker's resolution of every call, so a call is checked against the contract of
the method or function it resolves to, whatever form its receiver takes and in
whichever TS++ file of the program that declaration lives. When the callee could
be several declarations, as through a union of classes that each declare the
method, or is not one the verifier models, as through an interface, a call to a
method name that has a precondition somewhere is reported rather than accepted.
Without that resolution (an analyzer called directly, or code a syntax plugin
generated), the receiver's class is read from syntax: `this`, `super`,
`new C(...)`, a static `C.m(...)`, or a declaration with the type `C` or
initialized by `new C(...)`.

The invariant is a property of the object only while its fields cannot change
behind the verifier's back, so a class with an invariant may not let `this`
escape, write its invariant fields from closures or through other instances, or
declare async and generator members; before any call out of a member the
invariant must hold, since the callee may call back in. Invariants on derived
classes, refinement types on fields, and overriding a method that has a contract
are refused for now; an override in another file than its base is not detected.
The number models leave out `NaN`, so values from unverified code still need
checks where they enter.

String equality and scalar fields of ordinary records/discriminated unions are
lowered into the same symbolic state. Branch conditions over `_tag` fields feed
the path solver, so field arithmetic and postconditions can use the narrowed
branch facts without a second TypeScript type checker inside the plugin.

The `@tspp/plugin-formal-verification/smt` entry point defines reusable logic
without adding feature-specific hooks to compiler core. It supports declared and
defined functions, predicates, `forall`/`exists`, trusted axioms, recursive
`define-fun-rec` definitions, conditionals, arithmetic, and JavaScript-compatible
integer division/remainder. Logic declarations are collected program-wide, so a
contract may call a definition owned by another source file in the same package.

Recursive algebraic data declarations are projected as tagged structures for
proofs. Constructor returns establish tag/scalar-field postconditions and switch
cases add the corresponding path fact; recursive payloads remain opaque until a
scalar field is selected, keeping the SMT model finite.

All feature syntax is projected to equal-length whitespace before the upstream
TypeScript parser runs. Core only schedules the SDK's generic preprocessor and
background analyzer hooks; parsing, symbolic execution, SMT lowering, solver
isolation, diagnostics, and editor grammar remain in this package.

Every obligation also publishes a replayable SMT-LIB analysis artifact. In the
development host, run **TS++: Show SMT Source** to open the obligations for the
active file, ordered by source position and labelled with their proof status.
**TS++: Show Analysis Artifacts** remains available for viewing outputs from all
enabled capsules together. The editor consumes the SDK's generic artifact shape
and does not know about Z3 or formal-verification internals.
