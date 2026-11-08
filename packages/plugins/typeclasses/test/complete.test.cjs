// Generic implementations, `where` beyond function declarations, function types, inherent methods, and superclasses.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { ts, usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { typeclassesPlugin } = require("../dist");

usePlugins(typeclassesPlugin);

const messages = source => diagnosticMessages(createProgram(source).program);

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

const eq = `
typeclass Eq<A> { equals(a: A, b: A): boolean; }
impl NumberEq = Eq<number> { equals(a, b) { return a === b; } }
class Box<T> { constructor(readonly value: T) {} }
impl<T> BoxEq = Eq<Box<T>> where <Eq<T>> {
  equals(a, b) { return Eq.equals(a.value, b.value); }
}
function equal<T>(a: T, b: T) where <Eq<T>>: boolean { return Eq.equals(a, b); }
`;

test("an implementation holds several methods without commas", () => {
  const { exports } = run(`
    typeclass Both<A> { first(a: A): A; second(a: A): A; }
    impl NumberBoth = Both<number> {
      first(a) { return a + 1; }
      second(a) { return a + 2; }
    }
    export const sum = Both.first(1) + Both.second(1);
  `);
  assert.equal(exports.sum, 5);
});

test("a generic implementation is built from what its where clause finds", () => {
  const { exports, outputs } = run(`${eq}
    export const one = equal(new Box(1), new Box(1));
    export const two = equal(new Box(new Box(1)), new Box(new Box(2)));
  `);
  assert.deepEqual([exports.one, exports.two], [true, false]);
  assert.match(outputs.get("/main.js"), /equal\(BoxEq\(NumberEq\), /);
  assert.match(outputs.get("/main.js"), /equal\(BoxEq\(BoxEq\(NumberEq\)\), /);
});

test("a failure names the path through generic implementations", () => {
  assert.match(messages(`${eq} export const wrong = equal(new Box(true), new Box(false));`).join(), /'Eq<Box<boolean>>': using BoxEq requires 'Eq<boolean>': no implementation/);
});

test("a search that returns to itself is reported, not followed", () => {
  const found = messages(`
    typeclass C<A> { c(a: A): void; }
    class W<T> { constructor(readonly v: T) {} }
    impl<T> Loop = C<T> where <C<T>> { c() {} }
    export const wrong = C.c(1);
  `);
  assert.match(found.join(), /returns to itself: number -> number|returns to itself: C<number> -> C<number>/);
});

test("a type parameter that the typeclass does not mention is an error", () => {
  assert.match(messages(`typeclass C<A> { c(a: A): void; } impl<T, U> Bad = C<T> { c() {} }`).join(), /must appear in the typeclass/);
});

test("an '@' context can hold generic implementations", () => {
  const { exports, outputs } = run(`${eq}
    const context = { NumberEq, BoxEq };
    export const literal = equal(@{ NumberEq, BoxEq }, new Box(1), new Box(1));
    export const saved = equal(@context, new Box(1), new Box(2));
  `);
  assert.deepEqual([exports.literal, exports.saved], [true, false]);
  assert.match(outputs.get("/main.js"), /equal\(BoxEq\(NumberEq\), /);
  assert.match(outputs.get("/main.js"), /equal\(context\.BoxEq\(context\.NumberEq\), /);
});

test("methods take where clauses, with the receiver's type arguments", () => {
  const { exports } = run(`${eq}
    class Holder<T> {
      constructor(readonly value: T) {}
      same(other: T) where <Eq<T>>: boolean { return Eq.equals(this.value, other); }
      with<U>(a: U, b: U) where <Eq<U>>: boolean { return Eq.equals(a, b); }
    }
    class Sub extends Holder<number> {}
    const object = { check<T>(a: T) where <Eq<T>>: boolean { return Eq.equals(a, a); } };
    export const a = new Holder(1).same(1);
    export const b = new Holder("x").with(1, 2);
    export const c = new Sub(1).same(2);
    export const d = object.check(1);
  `);
  assert.deepEqual([exports.a, exports.b, exports.c, exports.d], [true, false, false, true]);
  assert.match(messages(`${eq} class H<T> { constructor(readonly v: T) {} same(o: T) where <Eq<T>>: boolean { return Eq.equals(this.v, o); } } export const wrong = new H(true).same(false);`).join(), /'Eq<boolean>'/);
});

test("interface methods take where clauses too", () => {
  const { exports } = run(`${eq}
    interface Checker { check<T>(a: T, b: T) where <Eq<T>>: boolean; }
    class Impl implements Checker { check<T>(a: T, b: T) where <Eq<T>>: boolean { return Eq.equals(a, b); } }
    const checker: Checker = new Impl();
    export const result = checker.check(1, 1);
  `);
  assert.equal(exports.result, true);
});

test("a class keeps its dictionaries from construction", () => {
  const { exports, outputs } = run(`${eq}
    class Sorted<T> where <Eq<T>> {
      constructor(readonly value: T) { this.first = Eq.equals(value, value); }
      first: boolean;
      same(other: T): boolean { return Eq.equals(this.value, other); }
      nested(other: T): boolean { const inner = function () { return Eq.equals(other, other); }; return inner(); }
      later = () => Eq.equals(this.value, this.value);
    }
    const sorted = new Sorted(1);
    export const a = sorted.first;
    export const b = sorted.same(2);
    export const c = sorted.nested(2);
    export const d = sorted.later();
    export const e = new Sorted(@{ NumberEq }, 3).same(3);
    export const keys = Object.keys(sorted).join();
  `.replace("export const keys = Object.keys(sorted).join();", ""));
  assert.deepEqual([exports.a, exports.b, exports.c, exports.d, exports.e], [true, false, true, true, true]);
  assert.match(outputs.get("/main.js"), /new Sorted\(NumberEq, 1\)/);
  assert.match(messages(`${eq} class S<T> where <Eq<T>> { constructor(readonly v: T) {} } export const wrong = new S(true);`).join(), /'Eq<boolean>'/);
});

test("subclasses pass dictionaries to their base", () => {
  const { exports } = run(`${eq}
    class Base<T> where <Eq<T>> {
      constructor(readonly value: T) {}
      same(other: T): boolean { return Eq.equals(this.value, other); }
    }
    class Explicit<T> where <Eq<T>> extends Base<T> {
      constructor(value: T) { super(value); }
      again(other: T): boolean { return Eq.equals(other, other) && this.same(other); }
    }
    class Implicit extends Base<number> {}
    class Forward<T> where <Eq<T>> extends Base<T> {}
    export const a = new Explicit(1).again(1);
    export const b = new Implicit(1).same(2);
    export const c = new Forward(1).same(1);
  `);
  assert.deepEqual([exports.a, exports.b, exports.c], [true, false, true]);
});

test("dictionaries are out of reach where no instance has them", () => {
  assert.match(messages(`${eq} class S<T> where <Eq<T>> { static make<T>(a: T) { return Eq.equals(a, a); } }`).join(), /Cannot satisfy/);
  assert.match(messages(`${eq} class S<T> where <Eq<T>> { constructor(readonly v: T) {} field = Eq.equals(this.v, this.v); }`).join(), /field initializer/);
});

test("a type's where clause is checked wherever the type is used", () => {
  const types = `${eq}
    type IsNumber<T> = T extends number ? true : false;
    type Numeric<T> where <IsNumber<T>> = readonly [T];
    interface Ordered<T> where <Eq<T>> { readonly values: T; }
  `;
  assert.deepEqual(messages(`${types}
    export const a: Numeric<1> = [1];
    export const b: Ordered<number> = { values: 1 };
    type Pass<T> where <Eq<T>> = Ordered<T>;
    export const c: Pass<number> = { values: 2 };
  `), []);
  assert.match(messages(`${types} export const wrong: Numeric<string> = ["x"];`).join(), /'IsNumber<T>' is false/);
  assert.match(messages(`${types} export const wrong: Ordered<boolean> = { values: true };`).join(), /'Eq<boolean>'/);
  assert.match(messages(`${types} type Forgot<T> = Ordered<T>;`).join(), /'Eq<T>'/);
  assert.match(messages(`${types} interface Sub extends Ordered<boolean> {}`).join(), /'Eq<boolean>'/);
});

test("a function type with a where clause takes dictionaries when called", () => {
  const { exports, outputs } = run(`${eq}
    const constrained: <T>(a: T, b: T) where <Eq<T>> => boolean = equal;
    const expression = function <T>(a: T, b: T) where <Eq<T>>: boolean { return Eq.equals(a, b); };
    export const a = constrained(1, 1);
    export const b = expression(1, 2);
    const taken = equal;
    export const c = taken(2, 2);
  `);
  assert.deepEqual([exports.a, exports.b, exports.c], [true, false, true]);
  assert.match(outputs.get("/main.js"), /constrained\(NumberEq, 1, 1\)/);
});

test("signatures with different dictionaries do not stand for each other", () => {
  const relation = /different dictionaries/;
  assert.match(messages(`${eq} const u: <T>(a: T, b: T) => boolean = equal;`).join("\n"), relation);
  assert.match(messages(`${eq} declare function plain<T>(a: T, b: T): boolean; const c: <T>(a: T, b: T) where <Eq<T>> => boolean = plain;`).join("\n"), relation);
  assert.match(messages(`${eq} declare function apply(f: (a: number, b: number) => boolean): void; apply(equal);`).join("\n"), relation);
  assert.match(messages(`${eq}
    class A { m<T>(a: T) where <Eq<T>>: boolean { return Eq.equals(a, a); } }
    class B extends A { m<T>(a: T): boolean { return true; } }
  `).join("\n"), relation);
  assert.deepEqual(messages(`
    type IsNumber<T> = T extends number ? true : false;
    declare function p<T>(a: T) where <IsNumber<T>>: T;
    const same: <T>(a: T) where <IsNumber<T>> => T = p;
    export { same };
  `), []);
  assert.match(messages(`
    type IsNumber<T> = T extends number ? true : false;
    declare function p<T>(a: T) where <IsNumber<T>>: T;
    const lost: <T>(a: T) => T = p;
    export { lost };
  `).join("\n"), /not known to hold/);
});

const option = `
export class Option<T> { constructor(readonly value: T | undefined) {} }
impl<T> Option<T> {
  isSome(self): boolean { return self.value !== undefined; }
  map<U>(self, fn: (value: T) => U): Option<U> { return new Option(self.value === undefined ? undefined : fn(self.value)); }
}
impl Option<string> {
  lengthOrZero(self): number { return self.value === undefined ? 0 : 3; }
}
`;

test("inherent methods read as members and call module-level functions", () => {
  const { exports, outputs } = run(`${option}
    const some = new Option("abc");
    export const a = some.isSome();
    export const b = some.lengthOrZero();
    export const c = some.map(value => 3).value;
    export const d = Option.isSome(some);
    declare const maybe: Option<string> | undefined;
    export const e = (undefined as Option<string> | undefined)?.isSome();
  `.replace("declare const maybe: Option<string> | undefined;", ""), { strictNullChecks: false });
  assert.deepEqual([exports.a, exports.b, exports.c, exports.d, exports.e], [true, 3, 3, true, undefined]);
  assert.match(outputs.get("/main.js"), /Option\$isSome\(some\)/);
  assert.doesNotMatch(outputs.get("/main.js"), /prototype/);
});

test("a method of one instantiation is not a member of another", () => {
  assert.match(messages(`${option} export const wrong = new Option(1).lengthOrZero();`).join(), /Property 'lengthOrZero' does not exist/);
});

test("inherent members stay out of the type", () => {
  assert.match(messages(`${option} const shape: { isSome(): boolean } = new Option(1);`).join(), /Property 'isSome' is missing/);
  assert.match(messages(`${option} const key: keyof Option<number> = "isSome";`).join(), /not assignable/);
  assert.match(messages(`${option} export const taken = new Option(1).isSome;`).join(), /can only be called directly/);
});

test("inherent methods take where clauses on the block and on the method", () => {
  const { exports } = run(`${eq}
    export class Maybe<T> { constructor(readonly value: T) {} }
    impl<T> Maybe<T> where <Eq<T>> {
      contains(self, value: T): boolean { return Eq.equals(self.value, value); }
    }
    impl<T> Maybe<T> {
      same<U>(self, a: U, b: U) where <Eq<U>>: boolean { return Eq.equals(a, b); }
    }
    export const a = new Maybe(1).contains(1);
    export const b = new Maybe("x").same(1, 2);
    export const c = new Maybe(1).contains(@{ NumberEq }, 2);
  `);
  assert.deepEqual([exports.a, exports.b, exports.c], [true, false, false]);
  assert.match(messages(`${eq}
    class M<T> { constructor(readonly value: T) {} }
    impl<T> M<T> where <Eq<T>> { contains(self, value: T): boolean { return Eq.equals(self.value, value); } }
    export const wrong = new M(true).contains(false);
  `).join(), /'Eq<boolean>'/);
});

test("inherent methods reach their module from other files", () => {
  const files = {
    "/option.tspp": option,
    "/make.tspp": `import { Option } from "./option"; export function make() { return new Option("abc"); }`,
    "/main.tspp": `import { make } from "./make"; export const length = make().lengthOrZero();`,
  };
  const commonjs = run(files);
  assert.equal(commonjs.exports.length, 3);
  assert.match(commonjs.outputs.get("/option.js"), /exports\.Option\$lengthOrZero/);
  const esm = createProgram(files, { module: ts.ModuleKind.ESNext });
  assert.deepEqual(diagnosticMessages(esm.program), []);
  esm.program.emit();
  assert.match(esm.outputs.get("/main.js"), /import \* as \$inherent\w* from "\.\/option"/);
  assert.match(esm.outputs.get("/option.js"), /export function Option\$lengthOrZero/);
});

test("inherent implementations follow their rules", () => {
  const rule = (source, message) => assert.match(messages(source).join(), message);
  rule(`class C {} impl C { m(self): void {} } impl C { m(self): void {} }`, /already has an inherent method 'm'/);
  rule(`class C<T> { value!: T; } impl C<string> { d(self): string { return ""; } } impl C<number> { d(self): string { return ""; } }`, /already has an inherent method 'd'/);
  rule(`class C { m() {} } impl C { m(self): void {} }`, /already has a member 'm'/);
  rule(`class C {} impl C { m(): void {} }`, /must take 'self'/);
  rule(`class C {} impl C { m(self: C): void {} }`, /'self' takes its type/);
  rule(`class C {} impl C { m(self) {} }`, /must declare its return type/);
  rule(`type Shape = { a: number }; impl Shape { m(self): void {} }`, /must name a class or a nominal type/);
  const other = diagnosticMessages(createProgram({
    "/a.tspp": `export class C {}`,
    "/main.tspp": `import { C } from "./a"; impl C { m(self): void {} }`,
  }).program);
  assert.match(other.join(), /Only the module that declares 'C'/);
});

test("a typeclass can require another, and evidence for it gives the other", () => {
  const { exports, outputs } = run(`${eq}
    typeclass Ord<A> where <Eq<A>> { less(a: A, b: A): boolean; }
    impl NumberOrd = Ord<number> { less(a, b) { return a < b; } }
    function atMost<T>(a: T, b: T) where <Ord<T>>: boolean { return Ord.less(a, b) || Eq.equals(a, b); }
    export const a = atMost(1, 1);
    export const b = atMost(2, 1);
  `);
  assert.deepEqual([exports.a, exports.b], [true, false]);
  assert.match(outputs.get("/main.js"), /\$Eq: NumberEq/);
  assert.match(outputs.get("/main.js"), /\$Ord\w*\.\$Eq\.equals\(a, b\)/);
  assert.match(messages(`
    typeclass Base<A> { b(a: A): void; }
    typeclass Sub<A> where <Base<A>> { s(a: A): void; }
    impl NumberSub = Sub<number> { s() {} }
  `).join(), /'Base<number>'/);
});

function emitDeclarations(source) {
  const { program, outputs } = createProgram({ "/lib/index.tspp": source }, { declaration: true, emitDeclarationOnly: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const read = extension => [...outputs].find(([fileName]) => fileName.endsWith(extension))?.[1];
  return { tspp: read(".d.tspp"), typescript: read(".d.ts") };
}

const library = `
  export typeclass Eq<A> { equals(a: A, b: A): boolean; }
  export typeclass Ord<A> where <Eq<A>> { less(a: A, b: A): boolean; }
  export impl NumberEq = Eq<number> { equals(a, b) { return a === b; } }
  export impl NumberOrd = Ord<number> { less(a, b) { return a < b; } }
  export class Box<T> { constructor(readonly value: T) {} }
  export impl<T> BoxEq = Eq<Box<T>> where <Eq<T>> { equals(a, b) { return Eq.equals(a.value, b.value); } }
  export class Sorted<T> where <Ord<T>> {
    constructor(readonly value: T) {}
    check<U>(u: U) where <Eq<U>>: boolean { return Eq.equals(u, u); }
  }
  export interface Checker { check<T>(a: T) where <Eq<T>>: boolean; }
  export type Constrained = <T>(a: T) where <Eq<T>> => boolean;
  export type Same<T> where <Eq<T>> = readonly [T];
  export class Opt<T> { constructor(readonly value: T) {} }
  impl<T> Opt<T> {
    get(self): T { return self.value; }
    same(self, other: T) where <Eq<T>>: boolean { return Eq.equals(self.value, other); }
  }
`;

test(".d.tspp keeps the whole surface, and a consumer behaves the same", () => {
  const { tspp } = emitDeclarations(library);
  assert.match(tspp, /export typeclass Ord<A> where <Eq<A>>/);
  assert.match(tspp, /export impl<T> BoxEq = Eq<Box<T>> where <Eq<T>>;/);
  assert.match(tspp, /class Sorted<T> where <Ord<T>>/);
  assert.match(tspp, /check<U>\(u: U\) where <Eq<U>>: boolean;/);
  assert.match(tspp, /check<T>\(a: T\) where <Eq<T>>: boolean;/);
  assert.match(tspp, /<T>\(a: T\) where <Eq<T>> => boolean/);
  assert.match(tspp, /type Same<T> where <Eq<T>> = readonly \[T\];/);
  assert.match(tspp, /impl<T> Opt<T> \{/);
  const consumer = body => diagnosticMessages(createProgram({
    "/lib/index.d.tspp": tspp,
    "/main.tspp": `import { Eq, NumberEq, NumberOrd, Box, BoxEq, Sorted, Opt, Same } from "./lib/index"; void [NumberEq, NumberOrd, BoxEq]; ${body}`,
  }).program);
  assert.deepEqual(consumer(`
    export const a = Eq.equals(new Box(1), new Box(1));
    export const b = new Sorted(1).check(1);
    export const c = new Opt(1).get();
    export const d = new Opt(1).same(1);
    export const e: Same<number> = [1];
  `), []);
  assert.match(consumer(`export const wrong = new Sorted(true);`).join(), /'Ord<boolean>'/);
  assert.match(consumer(`export const wrong = new Opt(true).same(false);`).join(), /'Eq<boolean>'/);
  assert.match(consumer(`export const wrong = new Opt(1).missing();`).join(), /does not exist/);
});

test("the compatible .d.ts shows dictionaries as parameters", () => {
  const { typescript } = emitDeclarations(library);
  assert.match(typescript, /declare function BoxEq<T>\(__Eq: Eq<T>\): Eq<Box<T>>/);
  assert.match(typescript, /constructor\(__Ord: Ord<T>, value: T\)/);
  assert.match(typescript, /check<U>\(__Eq: Eq<U>, u: U\): boolean/);
  assert.match(typescript, /check<T>\(__Eq: Eq<T>, a: T\): boolean/);
  assert.match(typescript, /<T>\(__Eq: Eq<T>, a: T\) => boolean/);
  assert.doesNotMatch(typescript, /where/);
  assert.doesNotMatch(typescript, /impl\$/);
  assert.deepEqual(diagnosticMessages(createProgram({
    "/lib/index.d.ts": typescript,
    "/main.ts": `import { NumberEq, BoxEq, Box, Sorted, NumberOrd } from "./lib/index";
      export const a = BoxEq(NumberEq).equals(new Box(1), new Box(1));
      export const b = new Sorted(NumberOrd, 1).check(NumberEq, 1);`,
  }).program), []);
});

test("a data type and a newtype can have inherent methods", () => {
  // These are written in the nominal-types plugin's syntax, so they run only with it active.
  if (process.env.TSPP_TEST_ALL_PLUGINS !== "1") return;
  const { exports } = run(`
    export data Option<T> = Some(value: T) | None;
    impl<T> Option<T> {
      isSome(self): boolean { return self._tag === "Some"; }
    }
    export newtype Meters = number;
    impl Meters {
      twice(self): number { return (self as number) * 2; }
    }
    const some: Option<number> = Some(1);
    export const a = some.isSome();
    export const b = Meters(2).twice();
  `);
  assert.deepEqual([exports.a, exports.b], [true, 4]);
});

test("a dictionary written by hand holds its superclass, and is right at run time", () => {
  const ord = `${eq}
    typeclass Ord<A> where <Eq<A>> { less(a: A, b: A): boolean; }
    function atMost<T>(a: T, b: T) where <Ord<T>>: boolean { return Ord.less(a, b) || Eq.equals(a, b); }
  `;
  assert.match(messages(`${ord} const missing: Ord<number> = { less: (a, b) => a < b };`).join(), /missing the '\$' fields/);
  const { exports } = run(`${ord}
    const written: Ord<number> = { less: (a, b) => a < b, $Eq: NumberEq };
    export const result = atMost(@{ written }, 1, 1);
  `);
  assert.equal(exports.result, true);
  assert.match(messages(`${eq} type P = true; typeclass Bad<A> where <P> { b(a: A): void; }`).join(), /can only require other typeclasses/);
});

test("typeclasses of the same shape are unrelated as ordinary types too", () => {
  assert.match(messages(`
    typeclass A1<T> { m(a: T): void; }
    typeclass A2<T> { m(a: T): void; }
    declare const one: A1<number>;
    const two: A2<number> = one;
  `).join(), /not assignable/);
});

test("a superclass imported under another name still reaches its field", () => {
  const { exports } = run({
    "/base.tspp": `export typeclass Eq<A> { equals(a: A, b: A): boolean; } export impl NumberEq = Eq<number> { equals(a, b) { return a === b; } }`,
    "/main.tspp": `import { Eq as Same, NumberEq } from "./base";
      typeclass Ord<A> where <Same<A>> { less(a: A, b: A): boolean; }
      impl NumberOrd = Ord<number> { less(a, b) { return a < b; } }
      function f<T>(a: T) where <Ord<T>>: boolean { return Same.equals(a, a); }
      export const result = f(1);`,
  });
  assert.equal(exports.result, true);
});

test("signatures compare dictionaries by their type arguments", () => {
  const relation = /different dictionaries/;
  assert.match(messages(`${eq}
    class C<A, B> {
      declare f: (a: A) where <Eq<A>> => void;
      declare g: (a: A) where <Eq<B>> => void;
      m() { this.f = this.g; }
    }
  `).join("\n"), relation);
  assert.deepEqual(messages(`${eq}
    class C<A> {
      declare f: (a: A) where <Eq<A>> => void;
      declare g: (a: A) where <Eq<A>> => void;
      m() { this.f = this.g; }
    }
    declare const r: <T>(a: T, b: T) where <Eq<T>> => boolean;
    export const s: <U>(a: U, b: U) where <Eq<U>> => boolean = r;
  `), []);
  assert.match(messages(`
    type IsNumber<T> = T extends number ? true : false;
    class C<A, B> {
      declare f: (a: A) where <IsNumber<A>> => void;
      declare g: (a: A) where <IsNumber<B>> => void;
      m() { this.f = this.g; }
    }
  `).join("\n"), /not known to hold/);
});

test("a where clause can hold anonymous types", () => {
  const { exports } = run(`
    typeclass Eq<A> { equals(a: A, b: A): boolean; }
    impl PointEq = Eq<{ x: number }> { equals(a, b) { return a.x === b.x; } }
    impl<T> WrapEq = Eq<{ value: T }> where <Eq<T>> { equals(a, b) { return Eq.equals(a.value, b.value); } }
    type Is<A, B> = A extends B ? true : false;
    function g<T>(a: T) where <Is<T, { x: number }>>: T { return a; }
    function h<T>(a: T, b: T) where <Eq<{ value: T }>>: boolean { return Eq.equals({ value: a }, { value: b }); }
    export const a = Eq.equals({ x: 1 }, { x: 1 });
    export const b = g({ x: 1 }).x;
    export const c = h({ x: 1 }, { x: 2 });
  `);
  assert.deepEqual([exports.a, exports.b, exports.c], [true, 1, false]);
  assert.match(messages(`type Is<A, B> = A extends B ? true : false; function g<T>(a: T) where <Is<T, { x: number }>>: T { return a; } export const wrong = g(1);`).join(), /is false/);
});

test("an unused clause parameter is not reported", () => {
  const { program } = createProgram(`${eq} export function u<T>(a: T) where <Eq<T>>: T { return a; }`, { noUnusedParameters: true, noUnusedLocals: true });
  assert.deepEqual(diagnosticMessages(program).filter(message => /__tspp_where/.test(message)), []);
});

test("arrow functions take where clauses", () => {
  const { exports } = run(`${eq}
    const a1 = <T>(a: T, b: T) where <Eq<T>>: boolean => Eq.equals(a, b);
    const a2 = (a: number, b: number) where <Eq<number>> => Eq.equals(a, b);
    const typed: <T>(a: T, b: T) where <Eq<T>> => boolean = a1;
    export const x = a1(1, 1);
    export const y = a2(1, 2);
    export const z = typed(2, 2);
  `);
  assert.deepEqual([exports.x, exports.y, exports.z], [true, false, true]);
});

test("isolatedModules reports calls that need the whole program", () => {
  const { program } = createProgram(`${eq} export const value = equal(1, 1);`, { isolatedModules: true });
  assert.match(diagnosticMessages(program).join(), /'isolatedModules' rules out/);
});

test("transpiling one file refuses this syntax instead of dropping dictionaries", () => {
  assert.throws(() => ts.transpileModule(`${eq} export const value = equal(1, 1);`, { fileName: "/main.tspp", compilerOptions: { target: ts.ScriptTarget.ES2022 } }), /cannot be transpiled on its own/);
});

test("an inferred function type that declaration output would lose its clause on is an error", () => {
  const message = /declaration output cannot write/;
  const declared = source => diagnosticMessages(createProgram(`${eq} ${source}`, { declaration: true }).program);
  assert.match(declared(`export function mk() { return function <T>(a: T) where <Eq<T>>: boolean { return Eq.equals(a, a); }; }`).join(), message);
  assert.match(declared(`export const arrow = <T>(a: T) where <Eq<T>>: boolean => Eq.equals(a, a);`).join(), message);
  assert.deepEqual(declared(`export const named = equal; export function mk(): <T>(a: T) where <Eq<T>> => boolean { return equal; }`).filter(text => message.test(text)), []);
});

test("a typeclass only a clause names is written in declaration output", () => {
  const { tspp, typescript } = emitDeclarations(`
    typeclass Hidden<A> { h(a: A): void; }
    export function uses<T>(a: T) where <Hidden<T>>: void { Hidden.h(a); }
  `);
  assert.match(tspp, /typeclass Hidden<A>/);
  assert.match(typescript, /interface Hidden<A>/);
  assert.deepEqual(diagnosticMessages(createProgram({ "/lib/index.d.tspp": tspp, "/main.tspp": `import { uses } from "./lib/index"; export const wrong = uses(1);` }).program).length, 1);
});

test("editor features reach names in a where clause and inherent methods", () => {
  const source = `${eq}
    export function other<T>(a: T) where <Eq<T>>: boolean { return Eq.equals(a, a); }
    export class Opt<T> { constructor(readonly value: T) {} }
    impl<T> Opt<T> { get(self): T { return self.value; } }
    export const taken = new Opt(1).get();
  `;
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const service = createLanguageService("/main.tspp", source);
  const inClause = source.indexOf("Eq<T>>: boolean { return Eq.equals(a, a)");
  const definitions = service.getDefinitionAtPosition("/main.tspp", inClause);
  assert.ok(definitions?.some(definition => source.slice(definition.textSpan.start).startsWith("Eq")));
  const typeParameter = service.getDefinitionAtPosition("/main.tspp", inClause + 3);
  assert.ok(typeParameter?.some(definition => source.slice(definition.textSpan.start).startsWith("T>(a: T) where")));
  const references = service.findReferences("/main.tspp", source.indexOf("<T>(a: T) where") + 1);
  assert.ok(references?.[0].references.some(reference => reference.textSpan.start === inClause + 3));
  const renames = service.findRenameLocations("/main.tspp", source.indexOf("Eq<A>"), false, false, {});
  assert.ok(renames?.some(location => location.textSpan.start === inClause));
  const completions = service.getCompletionsAtPosition("/main.tspp", source.indexOf("get();"), {});
  assert.ok(completions?.entries.some(entry => entry.name === "get"));
  assert.ok(completions?.entries.some(entry => entry.name === "value"));
});

test("an inherent block's generated declarations are never reported as unused", () => {
  const source = `
    export class Box<T> { constructor(readonly value: T) {} }
    impl<T> Box<T> { get(self): T { return self.value; } }
    impl Box<number> { doubled(self): number { return self.value * 2; } }
  `;
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const service = createLanguageService("/main.tspp", source, { noUnusedLocals: true });
  const unused = [...service.getSemanticDiagnostics("/main.tspp"), ...service.getSuggestionDiagnostics("/main.tspp")]
    .filter(diagnostic => [6133, 6196].includes(diagnostic.code));
  assert.deepEqual(unused.map(diagnostic => diagnostic.messageText), []);
});

test("editor features find the names of an inherent method in error", () => {
  // As while it is typed: the receiver is not named 'self' yet.
  const source = `
    export class Box<T> { constructor(readonly value: T) {} }
    impl<T> Box<T> { get(selfx): T { return selfx.value; } }
  `;
  const { createLanguageService } = require("../../test-support/compile.cjs");
  const service = createLanguageService("/main.tspp", source);
  const name = source.indexOf("selfx)");
  const references = service.findReferences("/main.tspp", name);
  assert.ok(references?.[0].references.some(reference => reference.textSpan.start === source.indexOf("selfx.value")));
  assert.match(messages(source).join(), /must take 'self'/);
});

test("a where clause shown in a comment or string gets no semantic tokens", () => {
  const { typeclassSemanticTokens } = require("../dist/quickinfo.js");
  const code = "function equal<A>(a: A, b: A) where <Eq<A>>: boolean { return true; }";
  const sourceText = `typeclass Eq<A> { equals(a: A, b: A): boolean; }
// A function lists its typeclass constraints after 'where':
// Syntax: function <name><TypeParams>(<params>) where <<constraints>>: <ReturnType>
const shown = "where <Eq<A>>";
${code}
`;
  const tokens = typeclassSemanticTokens({ sourceText, tokens: [], imports: [], isOwned: () => true });
  const codeStart = sourceText.indexOf(code);
  assert.ok(tokens.length > 0);
  assert.deepEqual(tokens.filter(token => token.start < codeStart), []);
});
