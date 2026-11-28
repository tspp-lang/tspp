const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
usePlugins(require("../dist").advancedClassesPlugin);

function run(source, options = {}) {
  const { program, outputs } = createProgram(source, { noLib: false, ...options });
  assert.deepEqual(diagnosticMessages(program), []);
  const exports = {};
  new Function("exports", emitJavaScript(program, outputs))(exports);
  return exports;
}

test("mapped construction and private state do not depend on the extends list order", () => {
  for (const bases of ["A, B", "B, A"]) {
    const result = run(`
      const events: string[] = [];
      function arg(label: string, n: number) { events.push(label); return n; }
      class A {
        #a = (events.push("A.field"), 0);
        constructor(n: number) { this.#a = n; events.push("A.body"); }
        a() { return this.#a; }
      }
      class B {
        #b = (events.push("B.field"), 0);
        constructor(n: number = (events.push("B.default"), 2)) { this.#b = n; events.push("B.body"); }
        b() { return this.#b; }
      }
      class C extends ${bases} {
        c = (events.push("C.field"), 3);
        constructor() { super({ B: [arg("B.arg", 4)], A: [arg("A.arg", 5)] }); events.push("C.body"); }
      }
      const c = new C();
      export const result = [events, c.a(), c.b(), c.c, c instanceof A, c instanceof B, c instanceof C];
    `).result;
    assert.deepEqual(result, [["B.arg", "A.arg", "B.field", "B.body", "A.field", "A.body", "C.field", "C.body"], 5, 4, 3, true, true, true]);
  }
});

test("all argument expressions precede defaults and exceptions stop later base initialization", () => {
  const result = run(`
    const events: string[] = [];
    class A { constructor(n: number = (events.push("A.default"), 1)) { events.push("A.body"); } }
    class B { constructor(n: number) { events.push("B.body"); throw new Error("stop"); } }
    class C extends A, B {
      constructor() { super({ B: [(events.push("B.arg"), 2)], A: [(events.push("A.arg"), undefined)] }); }
    }
    try { new C(); } catch {}
    export const result = events;
  `).result;
  assert.deepEqual(result, ["B.arg", "A.arg", "B.body"]);
});

test("each base keeps native field/default order and a bare return does not skip other bases", () => {
  const result = run(`
    const events: string[] = [];
    class A {
      a = (events.push("A.field"), 1);
      constructor(n: number = (events.push("A.default"), 2)) { events.push("A.body"); }
    }
    class B {
      b = (events.push("B.field"), 3);
      constructor(n: number = (events.push("B.default"), 4)) { events.push("B.body"); return; }
    }
    class C extends A, B {
      constructor() {
        super({ B: [(events.push("B.arg"), undefined)], A: [(events.push("A.arg"), undefined)] });
        events.push("C.body");
      }
    }
    new C();
    export const result = events;
  `).result;
  assert.deepEqual(result, ["B.arg", "A.arg", "B.field", "B.default", "B.body", "A.field", "A.default", "A.body", "C.body"]);
});

test("construction packets survive reentrancy and new.target remains the final subclass", () => {
  const result = run(`
    const events: string[] = [];
    let nesting = false;
    class A {
      #a: number;
      constructor(n: number) { this.#a = n; events.push("A:" + n + ":" + new.target.name); }
      a() { return this.#a; }
    }
    class B {
      #b: number;
      constructor(n: number) {
        this.#b = n;
        events.push("B:" + n + ":" + new.target.name);
        if (!nesting) { nesting = true; new C(10); }
      }
      b() { return this.#b; }
    }
    class C extends A, B { constructor(n: number) { super({ B: [n + 1], A: [n] }); } }
    class D extends C {}
    const d = new D(1);
    export const result = [events, d.a(), d.b(), d instanceof A, d instanceof B, d instanceof D];
  `).result;
  assert.deepEqual(result, [["B:2:D", "B:11:C", "A:10:C", "A:1:D"], 1, 2, true, true, true]);
});

test("explicit super preserves instance and static receivers including getters", () => {
  const result = run(`
    class A {
      #a: number;
      constructor(n: number) { this.#a = n; }
      a() { return this.#a; }
      get value() { return this.#a; }
      static who() { return this.name; }
    }
    class B { constructor(public label: string) {} b() { return this.label; } }
    class C extends A, B {
      constructor() { super({ A: [7], B: ["ok"] }); }
      read() { return [super[A].a(), super[B].b(), super[A].value]; }
      static read() { return super[A].who(); }
    }
    class D extends C {}
    export const result = [new D().read(), D.read()];
  `).result;
  assert.deepEqual(result, [[7, "ok", 7], "D"]);
});

test("parenthesized super calls preserve their receiver and ordinary unary reads work with a shadowed Reflect", () => {
  const result = run(`
    class A {
      #a = 7;
      a() { return this.#a; }
      get value() { return this.#a; }
    }
    class B { b() { return 2; } }
    class C extends A, B {
      constructor() { super({ A: [], B: [] }); }
      read(Reflect: unknown) { return [(super[A].a)(), +super[A].value, !super[A].value]; }
    }
    export const result = new C().read(null);
  `).result;
  assert.deepEqual(result, [7, 7, false]);
});

test("nested mapped classes keep their own construction order and qualified super", () => {
  const result = run(`
    const events: string[] = [];
    class A { a() { return 1; } }
    class B { b() { return 2; } }
    class X { constructor(public x: number) { events.push("X"); } }
    class Y { #y: string; constructor(y: string) { this.#y = y; events.push("Y"); } y() { return this.#y; } }
    class Outer extends A, B {
      constructor() { super({ A: [], B: [] }); }
      make() {
        class Inner extends X, Y {
          constructor() { super({ Y: ["nested"], X: [5] }); }
          read() { return [this.x, super[Y].y()]; }
        }
        return new Inner().read();
      }
    }
    export const result = [new Outer().make(), events];
  `).result;
  assert.deepEqual(result, [[5, "nested"], ["Y", "X"]]);
});

test("qualified super retains protected access within the derived class", () => {
  const result = run(`
    abstract class A { protected constructor(n: number) {} protected a() { return 1; } }
    class B { protected b() { return 2; } }
    class C extends A, B {
      constructor() { super({ A: [7], B: [] }); }
      read() { return [super[A].a(), super[B].b()]; }
    }
    export const result = new C().read();
  `).result;
  assert.deepEqual(result, [1, 2]);
});

test("mapped argument checking keeps ordinary definite-assignment and pre-super this rules", () => {
  const prefix = "class A { constructor(n: number) {} } class B {} ";
  for (const [body, expectedCode] of [
    ["x = 1; constructor() { super({ A: [this.x], B: [] }); }", 17009],
    ["constructor() { let n: number; super({ A: [n], B: [] }); }", 2454],
  ]) {
    const { program } = createProgram(prefix + `class C extends A, B { ${body} }`, { noLib: false });
    assert(program.getSemanticDiagnostics().some(d => d.code === expectedCode));
  }
  const result = run(prefix + `
    class C extends A, B {
      value: number;
      constructor() { let n: number; super({ A: [n = 7], B: [] }); this.value = n; }
    }
    export const result = new C().value;
  `).result;
  assert.equal(result, 7);
});

test("editor diagnostics accept mapped super and keep ordinary inheritance unchanged", () => {
  const source = `
    class A { constructor(n: number) {} a() { return 1; } }
    class B { constructor(s: string) {} b() { return 2; } }
    class C extends A, B {
      constructor() { super({ A: [1], B: ["b"] }); }
      read() { return super[B].b(); }
    }
    class Plain extends A { constructor() { super(1); } read() { return super.a(); } }
  `;
  const service = createLanguageService("/main.tspp", source);
  try {
    assert.deepEqual(service.getSyntacticDiagnostics("/main.tspp"), []);
    assert.deepEqual(service.getSemanticDiagnostics("/main.tspp").map(d => d.messageText), []);
  } finally { service.dispose(); }
});
