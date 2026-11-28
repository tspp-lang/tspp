const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, createLanguageService } = require("../../test-support/compile.cjs");
const { advancedClassesPlugin } = require("../dist");
usePlugins(advancedClassesPlugin);

function diagnostics(files) {
  const { program } = createProgram(files, { noLib: false });
  return program.getSemanticDiagnostics().filter(d => d.code === 19125)
    .map(d => [d.file.fileName, d.file.text.slice(d.start, d.start + d.length)]);
}

test("rejects explicit prototype operations across files and retained type identities", () => {
  const result = diagnostics({
    "/bases.tspp": `export class A { a = 1 } export class B { b = 1 } B.prototype; class SubB extends B {} SubB.prototype;`,
    "/main.tspp": `
      import { A, B } from "./bases";
      class C extends A, B {} class D extends C {}
      const c = new C(), d = new D();
      const alias = C; const instance = c;
      A.prototype; alias.prototype; D["prototype"]; instance["__proto__"]; d.constructor;
      function generic<T extends C>(x: T, ctor: typeof C | typeof B, mixed: C & { extra: number }) {
        x.constructor; ctor.prototype; mixed.__proto__;
      }
      Object.getPrototypeOf(c); Reflect["setPrototypeOf"]({}, d); Object.create(c);
      const get = Object.getPrototypeOf; get(instance);
      const set = Reflect.setPrototypeOf; set(c, {});
      Object.prototype.isPrototypeOf.call(c, {});
      Object.prototype.isPrototypeOf.apply({}, [c]);
      c.isPrototypeOf({});
    `,
  });
  assert.deepEqual(result, [
    ["/bases.tspp", "prototype"], ["/bases.tspp", "prototype"],
    ...["prototype", '"prototype"', '"__proto__"', "constructor", "constructor", "prototype", "__proto__", "Object.getPrototypeOf", 'Reflect["setPrototypeOf"]', "Object.create", "get", "set", "Object.prototype.isPrototypeOf.call", "Object.prototype.isPrototypeOf.apply", "c.isPrototypeOf"].map(text => ["/main.tspp", text]),
  ]);
});

test("leaves ordinary types, shadows, user members and erased identities alone", () => {
  const result = diagnostics({ "/main.tspp": `
    class A { a = 1 } class B { b = 1 } class C extends A, B {}
    class Own extends C { ["constructor"] = 3; }
    const c = new C(); const own = new Own();
    A.prototype; new A().constructor; own.constructor;
    const erased: object = c; const anyValue: any = c;
    Object.getPrototypeOf(erased); Object.getPrototypeOf(anyValue); anyValue.__proto__; anyValue.prototype;
    Object.keys(c); const copy = { ...c }; c instanceof C; c.a; new C();
    function shadow(Object: { getPrototypeOf(x: unknown): void }, Reflect: { setPrototypeOf(x: unknown, y: unknown): void }) {
      Object.getPrototypeOf(c); Reflect.setPrototypeOf(c, c);
    }
    const pretend: typeof Object.getPrototypeOf = _x => null; pretend(c);
    const ordinary = { isPrototypeOf(_x: object) { return true; } }; ordinary.isPrototypeOf(c);
  ` });
  assert.deepEqual(result, []);
});

test("programs do not retain additional bases from earlier compilations", () => {
  assert.deepEqual(diagnostics({ "/main.tspp": `class A {} class B {} class C extends A, B {} B.prototype;` }).map(d => d[1]), ["prototype"]);
  assert.deepEqual(diagnostics({ "/main.tspp": `class B {} B.prototype;` }), []);
});

test("checks destructuring and known reflection keys without blocking ordinary members", () => {
  const result = diagnostics({ "/main.tspp": `
    class A { a = 1 } class B { b = 1 } class C extends A, B {}
    class Own extends C { ["constructor"] = 3; }
    const c = new C(), own = new Own();
    const { prototype: p } = B;
    const { __proto__: q, constructor: ctor } = c;
    const { constructor: allowed } = own;
    const { item: { constructor: nested } } = { item: c };
    const key = "prototype" as const, protoKey = "__proto__" as const;
    B[key]; c[\`__proto__\`];
    const { getPrototypeOf: get } = Object; get(c);
    const { setPrototypeOf } = Reflect; setPrototypeOf(c, {});
    Reflect.get(B, key); Reflect.set(c, protoKey, {}); Reflect.has(c, "constructor");
    Reflect.deleteProperty(B, "prototype"); Reflect.defineProperty(c, "__proto__", {});
    Object.getOwnPropertyDescriptor(B, "prototype"); Object.defineProperty(c, "constructor", {});
    Reflect.get(c, "a"); Object.defineProperty(c, "a", {});
    Reflect.get(own, "constructor");
    function f(Reflect: { get(x: unknown, k: string): void }) { Reflect.get(B, "prototype"); }
    const fake = { getPrototypeOf(_x: object) {} }; const { getPrototypeOf } = fake; getPrototypeOf(c);
  ` });
  assert.deepEqual(result.map(d => d[1]), ["prototype", "__proto__", "constructor", "constructor", "key", "`__proto__`", "get", "setPrototypeOf", "key", "protoKey", '"constructor"', '"prototype"', '"__proto__"', '"prototype"', '"constructor"']);
});

test("checks equivalent explicit syntax and each affected union constituent", () => {
  const result = diagnostics({ "/main.tspp": `
    class A { a = 1 } class B { b = 1 } class C extends A, B {}
    const c = new C();
    (Object.getPrototypeOf)(c); Object.getPrototypeOf!(c);
    const key = "getPrototypeOf" as const; Object[key](c);
    let proto: unknown, ctor: unknown;
    ({ prototype: proto } = B);
    ({ item: { constructor: ctor } } = { item: c });
    declare const mixed: typeof B | (C & { prototype: string }); mixed.prototype;
    declare const instance: C | { constructor: number }; instance.constructor;
    Reflect.getOwnPropertyDescriptor(B, "prototype");
    const erased: any = Object.getPrototypeOf; erased(c);
  ` });
  assert.deepEqual(result.map(d => d[1]), ["(Object.getPrototypeOf)", "Object.getPrototypeOf!", "Object[key]", "prototype", "constructor", "prototype", "constructor", '"prototype"']);
});

test("editor diagnostics enforce the same rule at the authored property", () => {
  const source = "class A {} class B {} class C extends A, B {} B.prototype;";
  const service = createLanguageService("/main.tspp", source);
  try {
    const errors = service.getSemanticDiagnostics("/main.tspp").filter(d => d.code === 19125);
    assert.equal(errors.length, 1);
    assert.equal(source.slice(errors[0].start, errors[0].start + errors[0].length), "prototype");
  } finally {
    service.dispose();
  }
});
