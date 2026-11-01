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
