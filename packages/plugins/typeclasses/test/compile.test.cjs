// End-to-end behavior: what compiles, what is reported, and what the emitted JavaScript computes.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { ts, usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { typeclassesPlugin } = require("../dist");

usePlugins(typeclassesPlugin);

const prelude = `
typeclass Eq<A, B = A> {
  equals(a: A, b: B): boolean;
}
impl NumberEq = Eq<number> {
  equals(a, b) { return a === b; }
}
function equal<A, B>(a: A, b: B) where <Eq<A, B>>: boolean {
  return Eq.equals(a, b);
}
`;

const messages = source => diagnosticMessages(createProgram(source).program);

/** Compiles `files`, requires no errors, and returns the exports of `/main.js` when it runs. */
function run(files, options) {
  const sources = typeof files === "string" ? { "/main.tspp": files } : files;
  const { program, outputs } = createProgram(sources, options);
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const loaded = new Map();
  const load = fileName => {
    if (loaded.has(fileName)) return loaded.get(fileName).exports;
    const module = { exports: {} };
    loaded.set(fileName, module);
    vm.runInNewContext(outputs.get(fileName), {
      module,
      exports: module.exports,
      require: specifier => load(`/${specifier.replace(/^\.\//, "").replace(/\.tspp$/, "")}.js`),
    });
    return module.exports;
  };
  return { exports: load("/main.js"), outputs };
}

test("passes the implementation in scope and calls through it", () => {
  const { exports, outputs } = run(`${prelude}
    export const same = equal(1, 1);
    export const different = equal(1, 2);
  `);
  assert.deepEqual([exports.same, exports.different], [true, false]);
  assert.match(outputs.get("/main.js"), /equal\(NumberEq, 1, 1\)/);
  assert.match(outputs.get("/main.js"), /function equal\(\$Eq[\w$]*, a, b\)/);
  assert.match(outputs.get("/main.js"), /\$Eq[\w$]*\.equals\(a, b\)/);
});

test("forwards the dictionary of an enclosing where clause", () => {
  const { exports, outputs } = run(`${prelude}
    function outer<T>(a: T, b: T) where <Eq<T, T>>: boolean {
      return equal(a, b);
    }
    export const result = outer(2, 2);
  `);
  assert.equal(exports.result, true);
  assert.match(outputs.get("/main.js"), /equal\(\$Eq[\w$]*, a, b\)/);
});

test("reads implementations from imports, in module output too", () => {
  const library = `
    export typeclass Show<A> { show(a: A): string; }
    export impl NumberShow = Show<number> { show(a) { return "n" + a; } }
  `;
  const main = `
    import { Show, NumberShow } from "./library";
    function display<T>(value: T) where <Show<T>>: string { return Show.show(value); }
    export const text = display(4);
  `;
  const { exports } = run({ "/library.tspp": library, "/main.tspp": main });
  assert.equal(exports.text, "n4");

  const esm = createProgram({ "/library.tspp": library, "/main.tspp": main }, { module: ts.ModuleKind.ESNext });
  assert.deepEqual(diagnosticMessages(esm.program), []);
  esm.program.emit();
  assert.match(esm.outputs.get("/main.js"), /import \{.*NumberShow.*\} from "\.\/library"/);
});

test("an import only generated code uses does not count as unused", () => {
  const { program } = createProgram({
    "/library.tspp": `
      export typeclass Show<A> { show(a: A): string; }
      export impl NumberShow = Show<number> { show(a) { return "n" + a; } }
    `,
    "/main.tspp": `
      import { Show, NumberShow } from "./library";
      declare function display<T>(value: T) where <Show<T>>: string;
      export const text = display(4);
    `,
  }, { noUnusedLocals: true });
  assert.deepEqual(diagnosticMessages(program), []);
});

test("an '@' context takes priority and is matched by the type of its properties", () => {
  const source = `${prelude}
    impl OtherEq = Eq<boolean> { equals() { return true; } }
    const Always: Eq<number> = { equals() { return true; } };
    const context = { selected: Always };
    function makeContext() { return { selected: Always }; }
    export const literal = equal(@{ Always }, 1, 2);
    export const renamed = equal(@{ chosen: Always }, 1, 2);
    export const saved = equal(@context, 1, 2);
    export const computed = equal(@makeContext(), 1, 2);
    export const fallback = equal(1, 2);
  `;
  const { exports } = run(source);
  assert.deepEqual([exports.literal, exports.renamed, exports.saved, exports.computed, exports.fallback], [true, true, true, true, false]);
});

test("the '@' context is evaluated once, before the ordinary arguments", () => {
  const { exports } = run(`${prelude}
    const order: string[] = [];
    function context() { order.push("context"); return { NumberEq }; }
    function argument(value: number) { order.push("argument"); return value; }
    export const result = equal(@context(), argument(1), argument(1));
    export const seen = order.join();
  `.replace("string[]", "any"));
  assert.equal(exports.result, true);
  assert.equal(exports.seen, "context,argument,argument");
});

test("an optional parameter can be left out when an '@' context is given", () => {
  const { exports } = run(`${prelude}
    function f<T>(a: T, b?: T) where <Eq<T, T>>: boolean { return b === undefined; }
    export const missing = f(@{ NumberEq }, 1);
  `);
  assert.equal(exports.missing, true);
});

test("rest arguments follow the dictionary", () => {
  const { exports } = run(`${prelude}
    function all<T>(...values: any) where <Eq<T, T>>: number { return values.length; }
    export const count = all<number>(1, 2, 3);
  `);
  assert.equal(exports.count, 3);
});

test("reports a constraint with no implementation", () => {
  const found = messages(`${prelude} export const wrong = equal(true, false);`);
  assert.equal(found.length, 1);
  assert.match(found[0], /Cannot satisfy the constraint 'Eq<boolean, boolean>'/);
});

test("reports a method call without evidence", () => {
  const found = messages(`${prelude} function invalid<A>(a: A, b: A) { return Eq.equals(a, b); }`);
  assert.equal(found.length, 1);
  assert.match(found[0], /Cannot satisfy the constraint 'Eq<A, A>'/);
});

test("reports two implementations in one layer, and '@' resolves it", () => {
  const ambiguous = `${prelude} impl SecondEq = Eq<number> { equals() { return true; } }`;
  assert.match(messages(`${ambiguous} export const wrong = equal(1, 2);`).join(), /several implementations: .*NumberEq.*SecondEq|several implementations: .*SecondEq.*NumberEq/);
  assert.deepEqual(messages(`${ambiguous} export const right = equal(@{ SecondEq }, 1, 2);`), []);
  assert.match(messages(`${ambiguous} export const wrong = equal(@{ NumberEq, SecondEq }, 1, 2);`).join(), /several implementations/);
});

test("matches type arguments by identity and typeclasses by name", () => {
  const literal = `${prelude} declare const one: 1; export const wrong = equal<1, 1>(one, one);`;
  assert.match(messages(literal).join(), /Eq<1, 1>/);
  const sameShape = `${prelude}
    typeclass Same<A, B = A> { equals(a: A, b: B): boolean; }
    function g<T>(a: T) where <Same<T, T>>: boolean { return Same.equals(a, a); }
    export const wrong = g(1);
  `;
  assert.match(messages(sameShape).join(), /Cannot satisfy the constraint 'Same<number, number>'/);
});

test("any takes no part in the search", () => {
  assert.match(messages(`${prelude} declare const value: any; export const wrong = equal(value, value);`).join(), /Cannot satisfy/);
});

test("rejects misplaced '@' arguments", () => {
  const position = /must be the first argument/;
  assert.match(messages(`${prelude} equal(1, 2, @{ NumberEq });`).join(), position);
  assert.match(messages(`${prelude} equal(@{ NumberEq }, @{ NumberEq }, 1, 2);`).join(), position);
  assert.match(messages(`${prelude} declare function plain(a: number): void; plain(@{ NumberEq }, 1);`).join(), /does not take an '@' context/);
  assert.match(messages(`${prelude} equal(@{ NumberEq, debug: true }, 1, 2);`).join(), /'debug' in this '@' context is not an implementation/);
});

test("a decorated class stays a decorated class", () => {
  const found = messages(`
    declare const dec: any;
    declare function f(x: unknown): void;
    f(@dec class {});
  `);
  assert.deepEqual(found.filter(message => /context/.test(message)), []);
});

test("predicates must reduce to true", () => {
  const predicates = `
    type IsNumber<T> = T extends number ? true : false;
    type Maybe = boolean;
    function f<T>(value: T) where <IsNumber<T>>: T { return value; }
    function g<T>(value: T) where <Maybe>: T { return value; }
  `;
  assert.deepEqual(messages(`${predicates} export const ok = f(1);`), []);
  assert.match(messages(`${predicates} export const wrong = f("x");`).join(), /Constraint 'IsNumber<T>' is false/);
  assert.match(messages(`${predicates} export const wrong = g(1);`).join(), /does not reduce to 'true'.*boolean/);
});

test("predicates are erased and a requirement carries into the body", () => {
  const { exports, outputs } = run(`
    type IsNumber<T> = T extends number ? true : false;
    function inner<T>(value: T) where <IsNumber<T>>: T { return value; }
    function outer<T>(value: T) where <IsNumber<T>>: T { return inner(value); }
    export const value = outer(5);
  `);
  assert.equal(exports.value, 5);
  assert.match(outputs.get("/main.js"), /function outer\(value\)/);
});

test("overloads are chosen by their predicates", () => {
  const overloads = `
    type IsNumber<T> = T extends number ? true : false;
    type IsString<T> = T extends string ? true : false;
    declare function pick<T>(value: T) where <IsNumber<T>>: 1;
    declare function pick<T>(value: T) where <IsString<T>>: 2;
  `;
  assert.deepEqual(messages(`${overloads}
    export const first: 1 = pick(1);
    export const second: 2 = pick("x");
  `), []);
  assert.match(messages(`${overloads} declare const flag: unique symbol; export const wrong = pick(flag);`).join(), /No overload's constraints hold/);
});

test("overloads must require the same typeclasses", () => {
  const found = messages(`${prelude}
    typeclass Other<A> { other(a: A): void; }
    declare function differ<T>(value: T) where <Eq<T, T>>: void;
    declare function differ<T>(value: T, more: T) where <Other<T>>: void;
  `);
  assert.match(found.join(), /must require the same typeclasses/);
});

test("a typeclass has no value of its own, and a constrained function cannot be called indirectly", () => {
  assert.deepEqual(messages(`${prelude} export const taken = equal; export const same = taken(1, 1);`), []);
  assert.match(messages(`${prelude} export const taken = equal.call(undefined, 1, 1);`).join(), /'call', 'apply', and 'bind'/);
  assert.match(messages(`${prelude} export const taken = Eq;`).join(), /can only be used to call its methods/);
  assert.match(messages(`${prelude} export const taken = Eq.equals;`).join(), /can only be used to call its methods/);
});

test("rules out shapes that have no meaning", () => {
  assert.match(messages(`typeclass P<A> { value: A; }`).join(), /may only declare methods/);
  assert.match(messages(`type X = number; impl Bad = X { }`).join(), /must name a typeclass/);
  assert.match(messages(`function f() where <>: void {}`).join(), /at least one constraint|Type argument list cannot be empty/);
  assert.match(messages(`function f() where <Missing>: void {}`).join(), /Cannot resolve the constraint 'Missing'/);
});

test("words stay ordinary where they are not this syntax", () => {
  assert.deepEqual(messages(`
    const typeclass = 1, impl = 2, where = 3;
    export const sum = typeclass + impl + where;
    export const object = { typeclass, impl, where };
    export const less = impl < where;
  `), []);
});

test("a method may have its own type parameters", () => {
  const { exports } = run(`
    typeclass Box<A> { wrap<U>(a: A, other: U): U; }
    impl NumberBox = Box<number> { wrap(a, other) { return other; } }
    export const kept = Box.wrap(1, "x");
  `);
  assert.equal(exports.kept, "x");
});

test("a return type alone comes from explicit type arguments", () => {
  const source = `
    typeclass Empty<A> { empty(): A; }
    impl NumberEmpty = Empty<number> { empty() { return 0; } }
  `;
  assert.equal(run(`${source} export const zero = Empty.empty<number>();`).exports.zero, 0);
  assert.equal(run(`${source} export const zero: number = Empty.empty();`).exports.zero, 0);
  assert.match(messages(`${source} export const wrong = Empty.empty();`).join(), /Cannot satisfy the constraint 'Empty<unknown>'/);
});

test("output parameters come from explicit type arguments", () => {
  const source = `
    typeclass Add<L, R, O> { add(l: L, r: R): O; }
    impl NumberAdd = Add<number, number, number> { add(l, r) { return l + r; } }
    function add<L, R, O>(l: L, r: R) where <Add<L, R, O>>: O { return Add.add(l, r); }
  `;
  assert.equal(run(`${source} export const sum = add<number, number, number>(1, 2);`).exports.sum, 3);
  assert.equal(run(`${source} export const sum: number = add(1, 2);`).exports.sum, 3);
  assert.match(messages(`${source} export const wrong = add(1, 2);`).join(), /Cannot satisfy the constraint 'Add<number, number, unknown>'/);
});

function emitDeclarations(source) {
  const { program, outputs } = createProgram({ "/lib/index.tspp": source }, { declaration: true, emitDeclarationOnly: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const read = extension => [...outputs].find(([fileName]) => fileName.endsWith(extension))?.[1];
  return { tspp: read(".d.tspp"), typescript: read(".d.ts") };
}

const library = `
  export typeclass Eq<A, B = A> { equals(a: A, b: B): boolean; }
  export impl NumberEq = Eq<number> { equals(a, b) { return a === b; } }
  export type IsNumber<T> = T extends number ? true : false;
  export function equal<A, B>(a: A, b: B) where <Eq<A, B>>: boolean { return Eq.equals(a, b); }
  export function checked<T>(value: T) where <IsNumber<T>>: T { return value; }
  export function both<T>(value: T, ...rest: T[]) where <Eq<T, T>, IsNumber<T>>: T { return value; }
`;

test(".d.tspp keeps the syntax, and a consumer gets the same behaviour from it", () => {
  const { tspp } = emitDeclarations(library);
  assert.match(tspp, /export typeclass Eq<A, B = A>/);
  assert.match(tspp, /export impl NumberEq = Eq<number>;/);
  assert.match(tspp, /function equal<A, B>\(a: A, b: B\) where <Eq<A, B>>: boolean;/);
  const consumer = body => diagnosticMessages(createProgram({
    "/lib/index.d.tspp": tspp,
    "/main.tspp": `import { Eq, NumberEq, equal, checked } from "./lib/index"; ${body}`,
  }).program);
  assert.deepEqual(consumer(`export const a = equal(1, 2), b = checked(1), c = Eq.equals(1, 1), d = equal(@{ NumberEq }, 1, 1);`), []);
  assert.match(consumer(`export const wrong = equal(true, false);`).join(), /Cannot satisfy/);
  assert.match(consumer(`export const wrong = checked("x");`).join(), /is false/);
});

test("the compatible .d.ts shows dictionaries as parameters and keeps predicates", () => {
  const { typescript } = emitDeclarations(library);
  assert.match(typescript, /interface Eq<A, B = A>/);
  assert.match(typescript, /declare const NumberEq: Eq<number>/);
  assert.match(typescript, /function equal<A, B>\(__Eq: Eq<A, B>, a: A, b: B\): boolean/);
  assert.match(typescript, /function checked<T>\(value: T, \.\.\.__where: IsNumber<T> extends true \? \[\] : \[never\]\): T/);
  assert.match(typescript, /function both<T>\(__where: never, __Eq: Eq<T, T>, value: T, \.\.\.rest: T\[\]\): T/);
  const consumer = body => diagnosticMessages(createProgram({
    "/lib/index.d.ts": typescript,
    "/main.ts": `import { NumberEq, equal, checked } from "./lib/index"; ${body}`,
  }).program);
  assert.deepEqual(consumer(`export const a = equal(NumberEq, 1, 2), b = checked(1);`), []);
  assert.ok(consumer(`export const wrong = equal(1, 2);`).length > 0);
  assert.ok(consumer(`export const wrong = checked("x");`).length > 0);
});

test(".ts files stay plain TypeScript", () => {
  const found = diagnosticMessages(createProgram({ "/plain.ts": `typeclass Eq<A> { equals(a: A): boolean; }` }).program);
  assert.ok(found.length > 0);
});

test("editor services survive the syntax", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const service = createLanguageService("/main.tspp", `${prelude} export const value = equal(@{ NumberEq }, 1, 2);`);
  const source = service.getProgram().getSourceFile("/main.tspp");
  for (let position = 0; position < source.text.length; position += 5) service.getQuickInfoAtPosition("/main.tspp", position);
  assert.equal(service.getQuickInfoAtPosition("/main.tspp", source.text.indexOf("Eq<A"))?.displayParts?.map(p => p.text).join(""), "typeclass Eq<A, B = A>");
  assert.ok(service.getQuickInfoAtPosition("/main.tspp", source.text.indexOf("equal<A")));
  assert.ok(service.getFormattingEditsForDocument("/main.tspp", {}));
  assert.deepEqual(service.getSemanticDiagnostics("/main.tspp").map(diagnostic => diagnostic.code), []);
});

test("refactors on a clause item that names a typeclass alone do not crash", () => {
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const source = `typeclass Show { show(): string; }
impl ShowImpl = Show { show() { return "s"; } }
function shown(a: string) where <Show>: number { return 1; }
class Shown where <Show> {}
interface Showing where <Show> {}
`;
  const service = createLanguageService("/main.tspp", source);
  for (let position = 0; position < source.length; position++) service.getApplicableRefactors("/main.tspp", { pos: position, end: Math.min(position + 4, source.length) }, {});
  assert.ok(service.findReferences("/main.tspp", source.indexOf("Show {"))?.[0].references.some(reference => reference.textSpan.start === source.indexOf("Show>: number")));
});
