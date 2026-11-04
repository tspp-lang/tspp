const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createLanguageService, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { advancedClassesPlugin } = require("../dist");

usePlugins(advancedClassesPlugin);

test("quick-info: returns rich information for TS++ keywords, classes, objects, and members", () => {
  const code = `
class Counter {
  field count: number = 0 {
    get() {
      return field;
    }
    set(v) {
      if (v >= 0) {
        field = v;
      }
    }
  }
}

object AppConfig {
  appName: string = "TS++ Advanced Classes Demo";
  version: number = 1;

  greet(name: string): string {
    return \`Hello \${name} from \${this.appName} v\${this.version}\`;
  }
}

data class Point(x: number, y: number)

const pointOrigin = new Point(0, 0);
const moved = with(pointOrigin, { x: 10, y: 20 });

sealed abstract class Shape {
  abstract area(): number;
}

final class SecureToken {
  constructor(public readonly secret: string) {}
}

class Service {
  final getServiceId(): string {
    return "service-v1";
  }
}
`;

  const service = createLanguageService("/test.tspp", code);

  function getDisplay(target) {
    const pos = code.indexOf(target);
    assert.ok(pos >= 0, `Target "${target}" not found in code`);
    const qi = service.getQuickInfoAtPosition("/test.tspp", pos);
    assert.ok(qi, `No quick info at "${target}" (pos ${pos})`);
    return qi.displayParts.map(p => p.text).join("");
  }

  // 1. Keywords
  assert.equal(getDisplay("field count"), "(TS++ keyword) field");
  assert.equal(getDisplay("field;\n    }"), "(TS++ backing storage) field: number");
  assert.equal(getDisplay("object AppConfig"), "(TS++ keyword) object");
  assert.equal(getDisplay("data class"), "(TS++ keyword) data");
  assert.equal(getDisplay("with(pointOrigin"), "(TS++ keyword) with");
  assert.equal(getDisplay("sealed abstract"), "(TS++ keyword) sealed");
  assert.equal(getDisplay("final class SecureToken"), "(TS++ keyword) final");

  // 2. Classes and Objects (no auto-injected boilerplate documentation)
  const shapeInfo = service.getQuickInfoAtPosition("/test.tspp", code.indexOf("Shape {"));
  assert.equal(getDisplay("Counter {"), "class Counter");
  assert.equal(getDisplay("AppConfig {"), "object AppConfig");
  assert.equal(getDisplay("Point(x: number"), "data class Point(x: number, y: number)");
  assert.equal(getDisplay("Shape {"), "sealed abstract class Shape");
  assert.equal(getDisplay("SecureToken {"), "final class SecureToken");
  assert.equal(shapeInfo.documentation, undefined, "Classes should not have auto-injected boilerplate doc");

  // 3. Members
  assert.equal(getDisplay("count: number"), "(property) Counter.count: number");
  assert.equal(getDisplay("v) {"), "(parameter) v: number");
  assert.equal(getDisplay("appName: string"), "(property) AppConfig.appName: string");
  assert.equal(getDisplay("version: number"), "(property) AppConfig.version: number");
  assert.equal(getDisplay("greet(name: string)"), "(method) AppConfig.greet(name: string): string");
  assert.equal(getDisplay("area(): number"), "(method) abstract Shape.area(): number");
  assert.equal(getDisplay("getServiceId(): string"), "(method) final Service.getServiceId(): string");

  // 4. Syntax highlighting (displayParts have proper kind classification)
  assert.ok(shapeInfo.displayParts.some(p => p.text === "sealed" && p.kind === "keyword"));
  assert.ok(shapeInfo.displayParts.some(p => p.text === "abstract" && p.kind === "keyword"));
  assert.ok(shapeInfo.displayParts.some(p => p.text === "class" && p.kind === "keyword"));
  assert.ok(shapeInfo.displayParts.some(p => p.text === "Shape" && p.kind === "className"));
});

test("modifier validation: reports error on invalid modifier combinations", () => {
  // final + abstract on class
  const prog1 = createProgram({
    "/final-abstract.tspp": "final abstract class Invalid {}",
  }).program;
  const msgs1 = diagnosticMessages(prog1);
  assert.ok(msgs1.some(m => /Cannot combine 'final' and 'abstract'/.test(m)), "Should report final abstract class error");

  // final + private on member
  const prog2 = createProgram({
    "/final-private.tspp": "class C { private final foo() {} }",
  }).program;
  const msgs2 = diagnosticMessages(prog2);
  assert.ok(msgs2.some(m => /'final' modifier cannot be used with a private modifier/.test(m)), "Should report final private member error");

  // field + abstract on member
  const prog3 = createProgram({
    "/field-abstract.tspp": "abstract class C { abstract field count: number; }",
  }).program;
  const msgs3 = diagnosticMessages(prog3);
  assert.ok(msgs3.some(m => /A field property cannot be 'abstract'/.test(m)), "Should report field abstract error");
});
