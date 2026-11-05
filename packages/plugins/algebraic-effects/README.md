# `@tspp/plugin-algebraic-effects`

Adds algebraic effects that compile to capability passing. This is the first phase
of issue 14: operations that resume where they were performed, which covers state,
configuration, logging, and dependency injection, at the cost of a method call.

```ts
effect Logger {
  info(message: string): void;
}

effect Config {
  get(key: string): string;
}

function calculate(orderId: string) / { Logger, Config }: number {
  const rate = Number(perform Config.get("TAX_RATE"));
  perform Logger.info(`Calculating tax for ${orderId}`);
  return 100 * (1 + rate);
}

const total = handle Config {
  get: key => "0.08",
} in handle Logger {
  info(message) { console.log(message); },
  return: value => value,
} in {
  calculate("ORD-2026");
};
```

compiles to:

```js
function calculate($effects_1, orderId) {
  const rate = Number($effects_1.Config.get("TAX_RATE"));
  $effects_1.Logger.info(`Calculating tax for ${orderId}`);
  return 100 * (1 + rate);
}
```

An `effect` declaration leaves no JavaScript, and code without effects compiles as
it would without this plugin. Each `handle` allocates one object for its body; a call
passes along the object it has whenever that holds what the callee requires.

## The rules

- **Clauses.** `/ E` or `/ { A, B }` goes after the parameters, before the return
  type, on functions, methods, and function types: `(x: number) / E => void`.
- **`perform`** finds the nearest `handle` of the effect or function listing it. A
  generic effect takes its type arguments from there, so `perform State.get()` is a
  `number` under `/ State<number>`.
- **`handle`** names its type arguments, as in `handle State<number> { ... }`. The
  value of the body is its last expression, or that of each final branch; the optional
  `return` clause maps it and decides the type of the whole expression. Handlers chain
  with `in handle ...`. A clause runs with the handlers around its `handle`.
- **Callbacks.** A function expression or arrow function without a clause captures
  what surrounds it. A function declaration or method without one starts with nothing,
  so a nested `function` must say what it needs.
- **Assignment.** A function may stand for one given more: `/ A` for `/ { A, B }`. A
  function with a clause and one without never stand for each other, in either
  direction, because capabilities come first: an ordinary function would read them as
  its first argument. Write a function with the clause as a wrapper.
- **Declarations.** `.d.tspp` keeps the syntax. `.d.ts` writes the capabilities as a
  first parameter: `__effects: { Logger: Logger; Config: Config; }`.

## Limits

Reported as errors:

- A `handle` body cannot use `return`, `await`, or `yield`, since it lowers to a
  function. Move them to a function the body calls.
- No inference: a function that performs an effect lists it, and there is no effect
  polymorphism, so `map<T, U>(f: (x: T) / E => U)` over any `E` cannot be written.
- One instance of an effect per clause, and two effects with the same name cannot be
  in scope together, because they would share a capability's property.
- A type argument of a callee's clause that nothing determines must be written out:
  `get<number>()`.
- Constructors and accessors cannot have clauses, because nothing could pass them
  capabilities, and neither can operations of an effect.
- A function with a clause cannot use `call`, `apply`, or `bind`, or be a template tag.
- `isolatedModules` reports calls that need capabilities, and `transpileModule` refuses
  a file with this syntax. As with typeclasses, it cannot see a file that only calls a
  function with a clause from another file.
- An inferred type holding a function with a clause must be annotated for declaration
  output.
- `control` and `suspend`, which take the continuation, belong to the second phase.

Not supported:

- A signature cannot have an effect clause and a `where` clause together.
- An arrow function with no parameters cannot have a clause: `() / E => 1` reads as
  division. Use a function expression, or capture what surrounds it.
- A handler's clauses are named by plain words, and its methods cannot be `async`:
  write `fetch: async url => ...`.

Not reported:

- A capability that outlives its `handle` keeps working on the handler it captured:
  `setTimeout(() => perform Logger.info("late"))` calls that handler after the `handle`
  has returned.
- `any` and casts can carry a function with a clause to where capabilities are not
  passed, which then reads an argument in their place.
