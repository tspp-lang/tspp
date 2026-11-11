const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages, emitJavaScript } = require("../../test-support/compile.cjs");
const { advancedClassesPlugin } = require("../dist");

usePlugins(advancedClassesPlugin);

function compile(files, options = {}) {
  const { program, outputs } = createProgram(files, options);
  return {
    program,
    messages: diagnosticMessages(program),
    javascript: () => emitJavaScript(program, outputs),
  };
}

test("object: declares a singleton instance and its type", () => {
  const result = compile(`
    object Counter {
      count = 0;
      inc(): number {
        this.count++;
        return this.count;
      }
    }

    const c: Counter = Counter;
    const v = c.inc();
  `);

  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /const Counter = new /);

  // Runtime evaluation test: v was inc() once (equals 1), second inc() equals 2
  const fn = new Function(js + "\nreturn { v, next: Counter.inc() };");
  assert.deepEqual(fn(), { v: 1, next: 2 });
});

test("final class: reports error when inherited", () => {
  const result = compile(`
    final class SealedBase {
      x = 1;
    }

    class Sub extends SealedBase {
      y = 2;
    }
  `);

  assert(result.messages.some(m => m.includes("Cannot inherit from final class 'SealedBase'")), result.messages.join("\n"));
});

test("final class: reports error when inherited by class with final method", () => {
  const result = compile(`
    final class SecureToken {
      constructor(public readonly secret: string) {}
    }

    class Service extends SecureToken {
      final getServiceId(): string {
        return "service-v1";
      }
    }
  `);

  assert(result.messages.some(m => m.includes("Cannot inherit from final class 'SecureToken'")), result.messages.join("\n"));
});

test("sealed class: allows same-file inheritance but forbids cross-file inheritance", () => {
  // 1. Same file: valid
  const validResult = compile(`
    sealed class Animal {
      name: string = "animal";
    }

    class Dog extends Animal {
      bark() { return "woof"; }
    }
  `);
  assert.deepEqual(validResult.messages, []);

  // 2. Cross file: forbidden
  const crossFileResult = compile({
    "/animal.tspp": `
      sealed class Animal {
        name: string = "animal";
      }
    `,
    "/sub.tspp": `
      class Cat extends Animal {
        meow() { return "meow"; }
      }
    `,
  });
  assert(
    crossFileResult.messages.some(m => m.includes("Cannot extend sealed class 'Animal' outside of its declaring file")),
    crossFileResult.messages.join("\n"),
  );
});

test("final member: reports error when overridden in subclass", () => {
  const result = compile(`
    class Service {
      final execute(): string {
        return "base";
      }
    }

    class CustomService extends Service {
      execute(): string {
        return "custom";
      }
    }
  `);

  assert(
    result.messages.some(m => m.includes("Cannot override final member 'execute' of class 'Service'")),
    result.messages.join("\n"),
  );
});

test("field: lowers backing property in getter and setter", () => {
  const result = compile(`
    class User {
      get count(): number {
        return field;
      }
      set count(v: number) {
        field = v;
      }
    }

    const u = new User();
    u.count = 42;
    const res = u.count;
  `);

  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /__field_count/);

  const fn = new Function(js + "\nu.count = 42; return u.count;");
  assert.equal(fn(), 42);
});

test("field property declaration: field count: number = 0 { get() { return field; } set(v) { field = v; } }", () => {
  const result = compile(`
    class Counter {
      field count: number = 0 {
        get() { return field; }
        set(v) { field = v; }
      }
    }

    const c = new Counter();
    c.count = 10;
    const val: number = c.count;
  `);

  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /__field_count/);

  const fn = new Function(js + "\nc.count = 10; return c.count;");
  assert.equal(fn(), 10);

  // Type safety check: invalid type assignment is rejected by type checker
  const invalidResult = compile(`
    class Counter {
      field count: number = 0 {
        get() { return field; }
        set(v) { field = v; }
      }
    }
    const c = new Counter();
    c.count = "invalid";
  `);
  assert(
    invalidResult.messages.some(m => m.includes("Type 'string' is not assignable to type 'number'")),
    invalidResult.messages.join("\n"),
  );
});

test("field: preserves parameters, arrow bindings, and local variables outside accessors", () => {
  const result = compile(`
    function read(term: { left: number; right: number }, field: "left" | "right"): number {
      return term[field];
    }
    const select = (field: "right") => read({ left: 1, right: 2 }, field);
    const field = 3;
    let total = field + select("right");
    {
      const field = (value: number) => value * 2;
      total += field(4);
    }
  `);

  assert.deepEqual(result.messages, []);
  const javascript = result.javascript();
  assert.doesNotMatch(javascript, /__field_/);
  assert.equal(new Function(javascript + "\nreturn total;")(), 13);
});

test("field: preserves imported value bindings", () => {
  const result = compile({
    "/values.tspp": "export const field = 3;",
    "/main.tspp": `import { field } from "./values"; export const total: number = field + 1;`,
  });
  assert.deepEqual(result.messages, []);
  assert.match(result.javascript(), /values_1\.field \+ 1/);
  assert.doesNotMatch(result.javascript(), /__field_/);
});

test("field: keeps ordinary type errors on bound variables", () => {
  for (const [source, code] of [
    ['const field = "text"; const value: number = field;', 2322],
    ["function multiply(field: string) { return field * 2; }", 2362],
    ["function read(term: { left: number }, field: boolean) { return term[field]; }", 2538],
    ['const field = (value: number) => value; field("text");', 2345],
  ]) {
    const result = compile(source);
    assert.deepEqual(result.program.getSemanticDiagnostics().map(diagnostic => diagnostic.code), [code], result.messages.join("\n"));
  }
});

test("field: accessors keep their backing storage even when an outer field binding exists", () => {
  const result = compile(`
    const field = 99;
    class Counter {
      field count: number = 1 {
        get() { return field; }
        set(value) { field = value; }
      }
    }
    const counter = new Counter();
    counter.count = 7;
  `);
  assert.deepEqual(result.messages, []);
  assert.match(result.javascript(), /this\.__field_count/);
  assert.deepEqual(new Function(result.javascript() + "\nreturn [counter.count, field];")(), [7, 99]);
});

test("field: reports one precisely located diagnostic for an unbound reference outside accessors", () => {
  for (const source of [
    "function outside() { return /* before */ field; }",
    "const fields = 1; const value = field;",
  ]) {
    const result = compile(source);
    const diagnostics = result.program.getSemanticDiagnostics();
    assert.deepEqual(diagnostics.map(diagnostic => diagnostic.code), [19104], result.messages.join("\n"));
    assert.equal(diagnostics[0].start, source.lastIndexOf("field"));
    assert.equal(diagnostics[0].length, 5);
    assert.equal(diagnostics[0].messageText, "'field' is only allowed inside a getter or setter.");
    assert.equal(diagnostics[0].relatedInformation, undefined);
    assert.equal(diagnostics[0].canonicalHead, undefined);
  }
});

test("data class: synthesizes constructor, copy, equals, and toString", () => {
  const result = compile(`
    data class Point(x: number, y: number)

    const p1 = new Point(10, 20);
    const p2 = p1.copy({ y: 30 });
    const eq = p1.equals(p2);
    const str = p1.toString();
  `);

  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /copy\(patch\)/);
  assert.match(js, /equals\(other\)/);
  assert.match(js, /toString\(\)/);

  const fn = new Function(js + `
    return {
      p1x: p1.x,
      p1y: p1.y,
      p2x: p2.x,
      p2y: p2.y,
      eq12: p1.equals(p2),
      eq11: p1.equals(new Point(10, 20)),
      str: p1.toString(),
    };
  `);

  const evaluated = fn();
  assert.equal(evaluated.p1x, 10);
  assert.equal(evaluated.p1y, 20);
  assert.equal(evaluated.p2x, 10);
  assert.equal(evaluated.p2y, 30);
  assert.equal(evaluated.eq12, false);
  assert.equal(evaluated.eq11, true);
  assert.equal(evaluated.str, "Point(x=10, y=20)");
});

test("with expression: copies and modifies object properties", () => {
  const result = compile(`
    data class User(name: string, age: number)

    const u1 = new User("Alice", 20);
    const u2: User = with(u1, { age: 21 });
  `);

  assert.deepEqual(result.messages, []);
  const js = result.javascript();

  const fn = new Function(js + `
    return { name: u2.name, age: u2.age };
  `);

  assert.deepEqual(fn(), { name: "Alice", age: 21 });

  // Type safety check: unknown properties in patch are rejected by type checker
  const invalidResult = compile(`
    data class User(name: string, age: number)
    const u1 = new User("Alice", 20);
    const u2 = with(u1, { unknownProp: 123 });
  `);
  assert(
    invalidResult.messages.some(m => m.includes("does not exist in type")),
    invalidResult.messages.join("\n"),
  );
});

test("async constructors remain unsupported", () => {
  const result = compile(`
    class Database {
      async constructor() {}
    }
  `);

  assert(
    result.messages.some(m => m.includes("'async' modifier cannot appear on a constructor declaration")),
    result.messages.join("\n"),
  );
});
