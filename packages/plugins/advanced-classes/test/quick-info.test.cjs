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

test("field out of an accessor reads as the backing storage it names, not as the keyword", () => {
  const code = `
function misplaced(): unknown {
  return field;
}
`;
  const service = createLanguageService("/test.tspp", code);
  const quickInfo = service.getQuickInfoAtPosition("/test.tspp", code.indexOf("field;"));
  assert.equal(quickInfo?.displayParts.map(part => part.text).join(""), "(TS++ backing storage) field");
});

test("field bindings retain ordinary Quick Info text, spans, and documentation", () => {
  for (const source of [
    "/** Selected value. */ const field = 3; const result = field;",
    "/** Selected value. */ let field: number = 3; const result = field;",
    "/** @param field Selected value. */ function read(field: number) { return field; }",
    "const read = (field: number) => field;",
    "/** Doubles the input. */ function field(input: number) { return input * 2; } const result = field(3);",
    "const object = { /** Selected value. */ field: 3 }; const result = object.field;",
    "class Marker {} const object = { field: new Marker() }; const result = object.field instanceof Marker;",
    "const object = { field: 3 }; const result = object.field satisfies number;",
  ]) {
    const ordinary = source.replace(/\bfield\b/g, "value");
    const position = source.lastIndexOf("field");
    const actual = createLanguageService("/test.tspp", source).getQuickInfoAtPosition("/test.tspp", position);
    const expected = createLanguageService("/test.tspp", ordinary).getQuickInfoAtPosition("/test.tspp", position);
    assert.ok(actual, source);
    assert.ok(expected, ordinary);
    assert.equal(ts.displayPartsToString(actual.displayParts).replace(/\bfield\b/g, "value"), ts.displayPartsToString(expected.displayParts));
    assert.deepEqual(actual.textSpan, expected.textSpan);
    assert.deepEqual(actual.documentation, expected.documentation);
    assert.equal(actual.kind, expected.kind);
  }
});

test("an imported field retains its alias Quick Info and declaration documentation", () => {
  function info(name) {
    const files = {
      "/values.tspp": `/** Selected value. */ export const ${name} = 3;`,
      "/main.tspp": `import { ${name} } from "./values"; export const result = ${name};`,
    };
    const service = ts.createLanguageService({
      getScriptFileNames: () => Object.keys(files),
      getScriptVersion: () => "1",
      getScriptSnapshot: file => file in files ? ts.ScriptSnapshot.fromString(files[file]) : undefined,
      getCurrentDirectory: () => "/",
      getCompilationSettings: () => ({ noLib: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }),
      getDefaultLibFileName: () => "/lib.d.ts",
      fileExists: file => file in files,
      readFile: file => files[file],
    });
    return service.getQuickInfoAtPosition("/main.tspp", files["/main.tspp"].lastIndexOf(name));
  }
  const actual = info("field");
  const expected = info("value");
  assert.ok(actual);
  assert.ok(expected);
  assert.equal(ts.displayPartsToString(actual.displayParts).replace(/\bfield\b/g, "value"), ts.displayPartsToString(expected.displayParts));
  assert.deepEqual(actual.textSpan, expected.textSpan);
  assert.deepEqual(actual.documentation, expected.documentation);
  assert.equal(actual.kind, expected.kind);
});
