# `ts-plus-plus/plugins/algebraic-effects`

Adds algebraic effects that compile to capability passing (issue 14). Operations
resume where they were performed by default, which covers state, configuration,
logging, and dependency injection at the cost of a method call. Operations marked
`suspend` hand their handler the continuation, for asynchronous code written in direct
style, schedulers, and resumable errors; see [Suspension](#suspension).

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

## Suspension

```ts
effect Http {
  suspend get<T>(url: string, fallback: T): T;
}

function title(id: number) / Http: string {
  return perform Http.get(`/todos/${id}`, { title: "" }).title;
}

const loaded: Promise<string> = handle Http {
  control get(url, fallback, k) {
    fetch(url).then(response => response.json()).then(value => k.resume(value), error => k.abort(error));
  },
} in {
  title(1);
};
```

- **Coloring.** A function whose clause lists an effect with a `suspend` operation is
  a generator, and calls to it are `yield*`. Its other code, and every function whose
  effects do not suspend, compile as before. This is decided by effect, not by
  operation, so adding a `suspend` operation to an effect changes the functions that
  list it.
- **`control` clauses** handle exactly the `suspend` operations, and take the
  continuation `k` as their last parameter. `k.resume(value)` makes the `perform`
  evaluate to `value`; `k.abort(error)` throws `error` there, where the body can catch
  it and `finally` blocks run. A clause that throws before it settles `k` is an abort.
  `k` settles once: the checker reports a second use on the straight path of a clause,
  and at run time a second use rejects the `handle`, or throws once it has settled. A
  clause that never mentions `k` is a warning, since the `handle` would never settle.
- **The value.** A `handle` with `control` clauses runs its body and promises its value,
  mapped by the `return` clause: its type is `Promise<R>`. The color of a function ends
  there; nothing inside is `async`. A `handle` without them is a generator when its body
  suspends for an outer handler, and its value is then the value itself.
- **Requests carry their handler.** A suspension yields `[handler, operation, args]`, and
  the nearest driver, which is the nearest `handle` with `control` clauses, calls that
  handler's clause. So `k` goes on with the computation up to that driver. A clause that
  resumes at once goes on in the driver's loop, so the stack does not grow.
- **No runtime package.** Each file that needs the driver gets its own copy, as
  TypeScript does with `__awaiter`.
- **Declarations.** `.d.tspp` keeps `suspend`. `.d.ts` writes a suspending function's
  return type as `Generator<unknown, R, unknown>`, and the effect's interface gains a
  `__tspp_handler` property, the type its handlers satisfy.

What it costs: resuming at once, a suspension takes about 0.1 µs, and a call to a
suspending function adds about as much again, against a few nanoseconds for an
operation that does not suspend (a million iterations, Node 22). Only functions whose
clauses list a suspending effect pay it.

Reported as errors:

- Suspending anywhere but directly in a function whose clause lists a suspending
  effect, or in the body of a `handle` with `control` clauses. A callback without a
  clause, such as one passed to `forEach`, cannot suspend: write a loop, or give the
  callback the clause. A parameter's default value cannot suspend either.
- A function that may suspend and one that cannot never stand for each other.
- An `async` function or a generator cannot list a suspending effect.
- A `control` clause for an operation that does not suspend, or an ordinary clause for
  one that does.

A continuation is one-shot: an operation cannot be resumed twice to explore two
outcomes. A `handle` body that suspends is started with the `this` of the code around
it, but `arguments` there is its own.

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
