// Features that only exist when two plugins meet. Each plugin's own tests load that plugin alone, so cases that need
// another plugin live here, where every plugin is loaded.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

test("a nominal data type constructor is a higher-kinded argument", () => {
  const { program } = createProgram(`
    type Apply<F: Type => Type, A> = F<A>;
    data Option<T> = None | Some(value: T);
    type Applied = Apply<Option, number>;
    export const some: Applied = Some(1);
  `);
  assert.deepEqual(diagnosticMessages(program), []);
});

test("newtype and data parameters accept kind annotations", () => {
  const { program } = createProgram(`
    interface List<T> { head: T }
    newtype Boxed<F: Type => Type> = F<number>;
    data Wrap<F: Type => Type> = Wrap(value: F<string>);
    declare const boxed: Boxed<List>;
    declare const wrapped: Wrap<List>;
    const n: number = boxed.head;
    const s: string = wrapped.value.head;
    const badBoxed: string = boxed.head;
    type BadNewtype = Boxed<number>;
    type BadData = Wrap<string>;`);
  const messages = diagnosticMessages(program);
  assert.equal(messages.length, 3, messages.join("\n"));
  for (const message of messages) assert.match(message, /not assignable|has kind 'Type', but kind 'Type => Type' was expected/);
});

test("an unused let binding is reported on its name although nominal-types also filters unused diagnostics", () => {
  // Filters only see diagnostics inside their plugin's syntax, so the zero-width `infer` diagnostic reaches
  // type-computation, which moves it onto the binding name, and the brand's goes to nominal-types, which drops it.
  const source = "newtype Id = number;\nexport const id = Id(1);\nexport type T = let Unused = number in string;";
  const { program } = createProgram(source, { noUnusedLocals: true, noUnusedParameters: true });
  const reported = program.getSemanticDiagnostics().map(diagnostic => source.slice(diagnostic.start, diagnostic.start + diagnostic.length));
  assert.deepEqual(reported, ["Unused"]);
});
