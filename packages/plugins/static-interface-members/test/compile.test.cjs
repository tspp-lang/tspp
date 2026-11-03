// End-to-end behavior of static interface members: binding, the static-side check of `implements`, and declarations.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, createLanguageService } = require("../../test-support/compile.cjs");
const { staticInterfaceMembersPlugin } = require("../dist");

usePlugins(staticInterfaceMembersPlugin);

function diagnosticsOf(source, options) {
  const { program } = createProgram(source, options);
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(diagnostic => ({
    code: diagnostic.code,
    text: source.slice(diagnostic.start, diagnostic.start + diagnostic.length),
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
}

const serializable = `interface Serializable {
  static readonly mediaType: string;
  static deserialize(data: string): this;
  serialize(): string;
}
`;

test("a class satisfying both sides of an interface with static members type-checks", () => {
  assert.deepEqual(diagnosticsOf(serializable + `
class User implements Serializable {
  static readonly mediaType = "user";
  static deserialize(data: string): User { return new User(); }
  serialize(): string { return ""; }
}
interface Versioned extends Serializable { static fromVersion(version: number): this; }
class VersionedUser implements Versioned {
  static readonly mediaType = "versioned";
  static deserialize(data: string): VersionedUser { return new VersionedUser(); }
  static fromVersion(version: number): VersionedUser { return new VersionedUser(); }
  serialize(): string { return ""; }
}
export const user: User = User.deserialize("{}");
`), []);
});

test("a missing static member is reported on the class with the static side's members", () => {
  assert.deepEqual(diagnosticsOf(`interface Parser { static parse(text: string): number; }\nclass NoParse implements Parser { }\n`), [{
    code: 18074,
    text: "NoParse",
    message: "Class static side 'typeof NoParse' incorrectly implements static side of interface '{ parse(text: string): number; }'.\n"
      + "  Property 'parse' is missing in type 'typeof NoParse' but required in type '{ parse(text: string): number; }'.",
  }]);
});

test("an incompatible static member is elaborated like the instance side", () => {
  assert.deepEqual(diagnosticsOf(`interface Parser { static parse(text: string): number; }\nclass TextParser implements Parser { static parse(text: string): string { return text; } }\n`), [{
    code: 18074,
    text: "TextParser",
    message: "Class static side 'typeof TextParser' incorrectly implements static side of interface '{ parse(text: string): number; }'.\n"
      + "  The types returned by 'parse(...)' are incompatible between these types.\n"
      + "    Type 'string' is not assignable to type 'number'.",
  }]);
});

test("this in a static member stands for the implementing class's instance type", () => {
  assert.deepEqual(diagnosticsOf(`interface S { static make(): this; clone(): this; }
class A implements S { clone(): this { return this; } static make(): A { return new A(); } }
class B implements S { clone(): this { return this; } static make(): number { return 1; } }
`), [{
    code: 18074,
    text: "B",
    message: "Class static side 'typeof B' incorrectly implements static side of interface '{ make(): B; }'.\n"
      + "  The types returned by 'make()' are incompatible between these types.\n"
      + "    Type 'number' is not assignable to type 'B'.",
  }]);
});

test("static members of base interfaces are owed as an intersection", () => {
  assert.deepEqual(diagnosticsOf(`interface S { static make(): this; }
interface T extends S { static other: number; }
class A implements T { static make(): A { return new A(); } }
`).map(diagnostic => [diagnostic.code, diagnostic.text, diagnostic.message.split("\n")[0]]), [
    [18074, "A", "Class static side 'typeof A' incorrectly implements static side of interface '{ other: number; } & { make(): A; }'."],
  ]);
});

test("the static side is only checked once the instance side holds", () => {
  assert.deepEqual(diagnosticsOf(`interface S { static make(): this; name: string; }\nclass A implements S { static make(): number { return 1; } }\n`)
    .map(diagnostic => [diagnostic.code, diagnostic.text]), [[2420, "A"]]);
});

test("an instance member that shares a static member's name carries the member-specific error", () => {
  assert.deepEqual(diagnosticsOf(`interface S { static a: number; }\nclass C implements S { static a = "x"; a = 1; }\n`), [{
    code: 2416,
    text: "a",
    message: "Property 'a' in type 'typeof C' is not assignable to the same property in base type '{ a: number; }'.\n"
      + "  Type 'string' is not assignable to type 'number'.",
  }]);
});

test("comment directives apply to the static-side check", () => {
  assert.deepEqual(diagnosticsOf(`interface S { static make(): this; }\n// @ts-expect-error\nclass A implements S { }\n`), []);
});

test("static members stay off the instance type and cannot reference the interface's type parameters", () => {
  assert.deepEqual(diagnosticsOf(`interface S { static make(): S; name: string; }
declare const s: S;
s.make();
interface Box<T> { static make(): T; value: T; }
`).map(diagnostic => [diagnostic.code, diagnostic.text]), [[2339, "make"], [2302, "T"]]);
});

test("static stays illegal on type literal members", () => {
  assert.deepEqual(diagnosticsOf(`type L = { static a: number };\n`).map(diagnostic => [diagnostic.code, diagnostic.text]), [[1070, "static"]]);
});

test("feature-rich declarations keep static members and the compatible ones leave them out", () => {
  const { program, outputs } = createProgram(`export interface S {\n  static make(): this;\n  name: string;\n}\n`, { declaration: true, emitDeclarationOnly: true });
  program.emit();
  const [header, ...declarations] = outputs.get("/main.d.tspp").split("\n");
  assert.match(header, /^\/\/ @tspp-plugins .*static-interface-members/);
  assert.equal(declarations.join("\n"), "export interface S {\n    static make(): this;\n    name: string;\n}\n");
  assert.equal(outputs.get("/main.d.ts"), "export interface S {\n    name: string;\n}\n");
});

test("hover describes a static interface member", () => {
  const source = serializable;
  const service = createLanguageService("/main.tspp", source);
  const quickInfo = service.getQuickInfoAtPosition("/main.tspp", source.indexOf("deserialize") + 1);
  assert.equal(ts.displayPartsToString(quickInfo.displayParts), "(method) Serializable.deserialize(data: string): this");
});
