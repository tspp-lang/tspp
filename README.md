# ts-plus-plus

**English** | [简体中文](README.zh.md)

> The design proposal in [#](https://github.com/tspp-lang/tspp/issues/2) is for demonstration only. It is not a plan, not a TODO, and not a commitment. Treat it as a preview of a possible direction rather than a roadmap.

ts-plus-plus is an experimental TypeScript-derived language. It supports many powerful type features, extending the capabilities of TypeScript's type system, while also designing modern language features at the value level.

TS++ starts from the [TypeScript 6.0.3 source snapshot at `050880ce`](https://github.com/microsoft/TypeScript/commit/050880ce59e30b356b686bd3144efe24f875ebc8). That upstream snapshot is preserved here as the root commit [`824eb723`](https://github.com/tspp-lang/tspp/commit/824eb7234d96fd5c538bdf693789399e6c758235) and tagged as `v0.0.0`. Every later commit belongs to the development of TS++.

<!-- markdownlint-disable -->

<div align="center">
<img width="180px" src="./packages/vscode-extension/tspp.svg" />
</div>

<!-- markdownlint-enable -->

Language extensions are opt-in and are selected individually in `tsppconfig.json`. Without `tsppconfig.json`, every TS++ feature is disabled and the compiler behaves like TypeScript; `.tspp` and `.d.tspp` files do not participate in project discovery or module resolution.

## Monorepo layout

The repository root coordinates the monorepo. Each product lives under `packages/`:

- `compiler` — the `ts-plus-plus` compiler, language services, build system, and test suite;
- `language-server` — the TS++ Language Server Protocol implementation;
- `vscode-extension` — the repository-local VS Code development extension;
- `examples` — runnable compiler and editor examples;
- `playground` — the browser playground, which runs the compiler sources in a web worker.

Run `npm ci` at the root for the compiler and npm workspaces. The language server keeps its
upstream pnpm lock (`npm run build:language-server` handles it). Use `npm run build:all` to build
the compiler, language server, tests, and playground.

## Contributors

<!-- markdownlint-disable -->

<a href="https://github.com/tspp-lang/tspp/graphs/contributors">
  <img src="assets/contributors.svg" alt="Contributors" />
</a>

<!-- markdownlint-enable -->

## Initialize a project

```sh
tspp --init
```

If the directory has no `tsconfig.json`, this creates one first. It then creates `tsppconfig.json` with `"extends": "./tsconfig.json"` without modifying an existing TypeScript config. The generated file records the compiler commit, lists every available feature with comments, and leaves all of them disabled.

Enable features manually:

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "tsppFeatures": [
      "higherKindedTypes",
      "nominalTypes",
      "macros",
      "formalContracts",
      "refinementTypes",
      "typeUniverses"
    ]
  }
}
```

Dependencies must also be listed explicitly. An unknown feature, duplicate feature, or missing dependency is a configuration error: compilation is rejected, and the compiler neither edits the file nor starts in a fallback mode. When source code uses a disabled feature, editors can offer a quick fix that adds the feature and its complete dependency chain to `tsppconfig.json`.

## TypeScript interoperability

TS++ uses TypeScript as its compatibility and FFI boundary:

- The TS++ compiler accepts `.ts`, `.js`, and `.tspp` sources. A `.tspp` source may import TypeScript or JavaScript source and may use ordinary TypeScript assertions when explicitly strengthening a boundary value.
- A `.ts` or `.js` source cannot import `.tspp` or `.d.tspp` source. It may still consume a compiled TS++ package through that package's JavaScript and `.d.ts` compatibility surface.
- Declaration emit for `.ts` remains `.d.ts`. Declaration emit for `.tspp` writes both a full-fidelity `.d.tspp` and a TypeScript-compatible `.d.ts` projection.
- TS++ package consumers prefer `package.json#tsppTypes` and the `tspp-types` exports condition. TypeScript consumers continue to use `types` and the standard `types` exports condition.

Conditional export keys are order-sensitive, so place `tspp-types` before `types` as shown below.

```json
{
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "tsppTypes": "./dist/index.d.tspp",
  "exports": {
    ".": {
      "tspp-types": "./dist/index.d.tspp",
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

The compatibility declaration is a conservative projection, not a textual rename. `newtype` becomes its underlying TypeScript type plus a constructor signature, `data` becomes a discriminated union plus variant declarations, contracts and macro-only declarations are omitted, dependent functions keep their callable domain but use an `unknown` result, and TS++ type computations or higher-kinded operations that TypeScript cannot express become `unknown`. The `.d.ts` output is required to form a closed graph that never references `.d.tspp`.

See [`packages/examples/07-typescript-interop`](./packages/examples/07-typescript-interop) for a mixed-source library and an upstream TypeScript consumer.

## What a feature can change

Each feature is evaluated on two independent properties:

- **TypeScript superset**: existing TypeScript syntax, type checking, and runtime behavior remain compatible.
- **Transparent erasure**: the feature is implemented by removing type syntax only; it does not generate or change JavaScript runtime code.

A configured language remains a TypeScript superset only if every enabled feature preserves the first property. It remains transparently erasable only if every enabled feature preserves the second. Declaration-file preservation is intentionally not tracked as a separate property.

Current features:

| Feature | Provides | Explicit dependencies | TS superset | Transparent erasure |
| --- | --- | --- | --- | --- |
| `higherKindedTypes` | Higher-kinded parameters and first-class type constructors; kind annotations such as `F: Type => Type` additionally require `typeUniverses` | — | Yes | Yes |
| `nominalTypes` | `newtype` nominal declarations, `data` ADT discriminated unions, variant constructors, and exhaustive value-level `match` | — | Yes | No (emits runtime constructors, variant values, and match dispatch) |
| `macros` | `macro function` declarations and compile-time `macro f(Target);` statement expansion; public SDK `ts-plus-plus/macros` | — | Yes | No (macro calls can replace emitted statements) |
| `formalContracts` | SMT-verified `requires`, `ensures`, and `while` invariants (standard SMT-LIB 2.6, solver-independent) | — | Yes | Yes |
| `refinementTypes` | SMT-verified predicates on structural type aliases | `formalContracts` | Yes | Yes |
| `smtLibraries` | User logic functions, predicates, and axioms written with `ts-plus-plus/smt` and called from contracts; logic modules run at compile time | `formalContracts` | Yes | Yes (logic functions are specification-only) |
| `typeComputation` | Type-level `let X = T in U` bindings, pattern matching `match T { ... }`, and type lambdas `<T> =>> Body` | — | Yes | Yes |
| `modernSyntax` | Value-level `let ... in ...` expressions, `do { ... }` block expressions, `do` functions/methods with implicit return, and `use pattern <- expr` trailing closure desugaring | — | Yes | No (emits runtime IIFEs, trailing closure callbacks, and explicit returns) |
| `typeUniverses` | `Type0`, `Type1`, … and kind stratification | `higherKindedTypes` | Yes | Yes |
| `dependentFunctionTypes` | Pi types plus explicit `Lam`/`Ann` MLTT terms | `typeUniverses` | Yes | Yes |
| `dependentFunctionInterop` | Assignment and calls between Pi types and TypeScript generic functions | `dependentFunctionTypes` | Yes | Yes |
| `typeMatching` | Exact type and reified-descriptor `match mltt`; legacy `IfType`/`TypeMatch` share the same core | `dependentFunctionTypes` | Yes | Yes |
| `naturalNumbers` | `Nat`, `Zero`, and `Succ` type-level naturals | `dependentFunctionTypes` | Yes | Yes |
| `naturalNumberAddition` | Reducible `NatAdd` | `naturalNumbers` | Yes | Yes |
| `naturalNumberElimination` | The dependent `NatElim` eliminator | `naturalNumbers` | Yes | Yes |
| `booleans` | `Bool`, `True`, and `False` type-level booleans | `dependentFunctionTypes` | Yes | Yes |
| `booleanElimination` | The dependent `BoolElim` eliminator and `If` | `booleans` | Yes | Yes |
| `identityTypes` | `Eq`, `Refl`, and `J` path induction | `dependentFunctionTypes` | Yes | Yes |
| `sigmaTypes` | `Sigma`, `Pair`, `First`, and `Second` | `dependentFunctionTypes` | Yes | Yes |

The generated configuration is the authoritative, compiler-version-specific feature guide. The project is still experimental; these classifications describe the listed implementation, not a permanent promise about future features.

## Verification architecture

Verification is layered (see [issue #27](https://github.com/tspp-lang/tspp/issues/27)):

1. **SMT IR** — a solver-independent model of SMT-LIB 2.6: sorts (primitive, datatype, uninterpreted), open symbol application, quantifiers with patterns, `let`, declared and defined functions, and a raw SMT-LIB term escape hatch. Raw text must contain exactly one term and cannot inject declarations or solver-session commands. Every application is sort-checked against the standard theory signatures (Core, Ints, Reals, Reals_Ints, Strings, Datatypes) or a declared function; there is no closed operator list.
2. **Program semantics** — how TypeScript/JavaScript operations map onto that IR. An operation lowers to a logic term *plus* the definedness obligations its runtime behaviour needs: bigint `%` is JavaScript's truncated remainder (`-3n % 2n === -1n`, a `define-fun` in the output, not SMT `mod`) and requires a provably non-zero divisor. Specifications (`requires`, `ensures`, invariants, predicates, `assert:`/`assume:`) are erased and never run, so they are logic and create no runtime obligations; a zero divisor in a specification yields an unspecified value, and a specification that must exclude it says so (`b !== 0n && a % b === 0n`).
3. **Proof context** — every assertion records where it comes from and whether it is trusted. `assume:`, axioms, and number-model assumptions are trusted inputs; requires, invariants, refinement facts, and callee summaries are discharged elsewhere. Trusted assertions are named, and a proved obligation reports the trusted inputs in the solver's unsat core.
4. **Backend** — the generated script contains only standard commands and theory symbols, with a `set-logic` computed from the theories it uses (`QF_LIA`, `QF_NIA`, `UFDTLIA`, … or `ALL`). Solving is a plain SMT-LIB protocol (`check-sat`, `get-value`, `get-unsat-core`, `get-info :reason-unknown`); timeouts and other solver options belong to the backend adapter, never to the script. Z3 is the bundled backend, and a host can plug in any SMT-LIB 2.6 solver.

TypeScript's own control-flow analysis is reused as a source of facts rather than replaced. Macro and verification work share a bounded analysis-worker queue, propagate cancellation and timeout outcomes, and reuse successful content-addressed obligations across incremental programs.

The MLTT core keeps its own terms, normalization, and definitional equality. A future MLTT refinement bridge should translate only its decidable arithmetic/equality fragment into Verification IR; it should not merge the MLTT core with the SMT representation.

## Formal contracts

Enable `formalContracts`, then attach contracts to a function and invariants to `while` statements:

```ts
function sumTo(n: bigint) with {
  requires: n >= 0n;
  ensures: result === n;
}: bigint {
  let current = 0n;
  while (current < n) with {
    invariant: [current >= 0n, current <= n];
  } {
    current += 1n;
  }
  return current;
}
```

Each `with` property name may appear only once. Use an array when `requires`, `ensures`, or `invariant` contains multiple conditions.

The current subset covers `boolean`, `bigint`, and `string`, local variables, assignments, branches, `switch`, multiple returns, invariant-annotated loops, and `requires` checks at direct call sites that resolve to project function declarations. Records, record literals, closed discriminated unions with a unique string `_tag`, TS++ `data` constructors, and recursive algebraic data are lowered from the types and control-flow narrowing already computed by the TypeScript checker into Verification IR product/sum types and then into SMT-LIB datatypes; the verifier does not implement a competing version of TypeScript narrowing. Optional properties, index signatures, and open unions currently produce an explicit `unknown`. Calls inside verified functions use the caller's assumptions and current symbolic path facts. The result of a direct call uses the callee's `ensures` as facts (marked `[summary]` and proved separately for the callee); a callee without `ensures` returns an arbitrary value of its type, and a callee without a body or one that can recurse back into the caller leaves the result `unknown`. Supported arithmetic is `+`, `-`, `*`, and, for `bigint`, `/` and `%` with JavaScript's truncating semantics. `number` is available only after choosing a `numberModel` in the contract:

- `"mathematical-real"` models numbers as mathematical reals. Rounding, overflow, NaN, Infinity, and -0 are not modelled, so this is a trusted assumption that every proof under it reports.
- `"safe-integer"` models numbers as integers within ±`Number.MAX_SAFE_INTEGER`, where IEEE-754 arithmetic is exact. Every `+`, `-`, `*` in executed code must provably stay in range, number `%` needs a non-zero divisor, and `/` (not integer division) and fractional literals are outside the model. Only the range of parameters is trusted. The model covers `number` variables, parameters, and results; `number` fields of records and `data` are outside it.

`numberModel` is declared per function, refinement type, or loop, with no file- or project-wide default, so the numeric semantics in use is visible where it applies.

Every obligation is reported as `proved`, `failed`, `unknown`, or `error`, with task outcomes distinguishing cancellation and timeout. Unsupported syntax and unavailable solver environments are compilation errors with an `unknown` result, never a successful proof. `Program.getVerificationArtifacts()` exposes the exact solver input, replayable SMT-LIB, status, decoded source-level counterexample, raw model, the trusted inputs a proof relies on, and source location. Each assertion in the SMT-LIB carries a comment with its kind and source, and library definitions carry their origin. The development extension's **TS++: Show Verification SMT-LIB** command opens every replayable input for the current file beside the source, ordered and annotated with its source lines.

Use `assert: condition;` inside a verified function to create a local proof obligation. `assume: condition;` skips proof and adds a trusted fact to the following path; it is intended for external boundaries the verifier cannot model, and a false assumption makes subsequent proofs unsound. A proof that uses an assumption says so in its message and `trustedInputs`. The `assert:`/`assume:` statement form is reserved for these proof directives, so calls to user-defined functions named `assert` or `assume` keep their ordinary meaning in all positions. Both directives are erased from JavaScript output. Hovering an obligation in the development extension shows its status and source-level counterexample directly.

### Logic libraries

With `smtLibraries`, contracts can call logic functions defined in ordinary modules with `ts-plus-plus/smt`:

```ts
import * as smt from "ts-plus-plus/smt";

export const isMultipleOf = smt.definePredicate(
  "isMultipleOf",
  [["value", smt.Int], ["factor", smt.Int]],
  (value, factor) => smt.and(smt.not(smt.eq(factor, 0n)), smt.eq(smt.js.rem(value, factor), 0n)),
);
```

`requires: isMultipleOf(x, 3n)` then verifies against that definition; TS++ has no built-in predicates, so `isEven`, `between`, and the like are written the same way. `Int` parameters also accept `number` in contracts, for the `safe-integer` model. Calls are recognized by the definition the function's type carries, not by name; the compiler evaluates only that declaration and its dependencies at compile time, through the same execution seam as macros, and re-validates the result as untrusted input. Logic functions are specification-only: calling one elsewhere is a compile error, and calling it at runtime throws. Non-recursive definitions become `define-fun`s and add no trusted input; `defineRecursiveFunction` (`define-fun-rec`, unchecked termination) and the axioms of `declareFunction` are trusted inputs and are reported when a proof uses them. `ts-plus-plus/smt` is a small standalone module; during compilation the compiler serves its own copy, so the IR always matches the running compiler.

## Compile-time macro SDK

Macros import their API from `ts-plus-plus/macros`, which the running compiler serves to every macro it executes (in Node and in browser hosts). Version 1 (`macroApiVersion`) promises stable export names, macro-owned types (`MacroTarget`, `MacroContext`, `MacroResult`, `MacroReturn`, `MacroFailure`, `MacroDiagnostic`, `MacroFunction`, `MacroTimeout`), curated type guards, `SyntaxKind`, `NodeFlags`, `DiagnosticCategory`, `forEachChild`, and `idText`; `context.factory` is the supported way to create nodes. The structural shapes of exported compiler AST types, `context.program`, `context.checker`, and `import * as ts from "ts-plus-plus"` are read-only, same-version-coupled capabilities without a compatibility promise.

## Exhaustive value matching

`nominalTypes` also enables expression-level matching over `data` values and compatible closed `_tag` unions:

```ts
data Result<T> = Ok(value: T) | Err(error: string);
declare const result: Result<string>;

const text = match result {
  Ok(value) if value.length > 0 => `value: ${value}`,
  Ok(_) => "empty",
  Err(error) => error,
};
```

Constructor fields are bound positionally. A branch may include an `if` guard after its pattern; guarded branches do not by themselves make a variant exhaustive, so a later guarded or unguarded branch can handle the remaining values. Duplicate, unknown, unreachable, and missing variants are diagnosed; `_` may be used as the final fallback branch. The scrutinee is evaluated exactly once. Editors can offer a quick fix that inserts every missing variant branch.

Nullary variants can share a branch through an or-pattern, such as `Idle | Loading => wait()`. Constructor patterns may be nested, for example `Wrapped(Ok(value)) => value`; nested bindings keep the exact field type, nested alternatives participate in exhaustiveness checking, and guards still require an unguarded fallback. A nested nullary constructor is written with parentheses (`Wrapped(None())`) to distinguish it from a field binding.

## Type computation: let-in, match, and type lambdas

Enable `typeComputation`, then use local type bindings, pattern matching, and anonymous type-level functions:

```typescript
// 1. Scoped local let-in bindings
type UserResponse<T> = let Payload = { data: T; timestamp: number } in {
  response: Payload;
  backup: Payload;
};

// 2. Type-level pattern matching (structural infer, ADT constructors, primitives, and literals)
type Classify<T> = match T {
  [infer Head, ...infer Tail]: { head: Head; tail: Tail },
  Array<infer U>: [U, "array"],
  1: "one",
  string: "is-string",
  _: "other"
};

// 3. Anonymous type lambdas (<T> =>> Body)
type Id = <T> =>> T;
type Swap = <A, B> =>> [B, A];

type Swapped = Swap<string, number>; // [number, string]
```

Type lambdas integrate with higher-kinded parameters. A lambda `<T> =>> Body` has kind `Type => Type` and can be passed anywhere a type constructor is expected:

```typescript
// Require typeComputation + higherKindedTypes.
type Apply<F: Type => Type, X> = F<X>;

type Doubled = Apply<<T> =>> [T, T], boolean>; // [boolean, boolean]
```

The lambda body may reference any type in scope. All type computation syntax is erased and produces no JavaScript output.

Hovering a type alias or type expression in the development extension displays its normalized form and kind directly.

## Modern syntax: let-in, do expressions, and do functions

Enable `modernSyntax` to use modern value-level functional expressions and implicit return functions:

```typescript
// 1. Scoped value-level let-in expressions
const sum = let x = 10, y = 20 in x + y;

// 2. do { ... } block expressions (implicit return of the tail completion value)
const user = do {
  const firstName = "Alan";
  const lastName = "Turing";
  `${firstName} ${lastName}`;
};

// 3. do functions and methods with implicit return
function computeDiscount(price: number, isVip: boolean): number do {
  const rate = isVip ? 0.8 : 0.95;
  price * rate;
}

class Calculator {
  public total(price: number): number do {
    computeDiscount(price, true) + 15;
  }
}

// 4. use pattern <- expr trailing closure sugar in do blocks and do functions
function runPipeline(): string do {
  use token <- withAuth("admin");
  use [code, status] <- withPair();
  use res <- withResource();
  `${res.name}: [${code}] ${status} for ${token}`;
}

// 5. Standard TS functions remain 100% untouched
function standard(): void {
  42; // pure expression statement, does NOT implicitly return
}
```

Value-level `let-in` and `do` expressions are lowered to self-invoking arrow functions (`(() => { ... })()`), `do` function bodies automatically rewrite the tail expression to `return expr;`, and `use pattern <- f(args); rest...` statements are lowered to trailing closure invocations `f(args, (pattern) => { rest... })`.

## License

Apache License 2.0. ts-plus-plus is derived from Microsoft's TypeScript; the original license, copyright notices and `NOTICE` remain in place, and modified files will be marked as modified. "TypeScript" is a trademark of Microsoft Corporation.
