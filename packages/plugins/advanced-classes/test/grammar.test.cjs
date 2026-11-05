const { test } = require("node:test");
const { getTSPPEditorKeywords } = require("@tspp/plugin-sdk/editor");
const { loadGrammars, assertScoped, assertLeavesAngleBracketsToTypeScript } = require("../../test-support/grammar.cjs");
const { advancedClassesPlugin } = require("../dist");

const grammars = loadGrammars(`${__dirname}/..`, advancedClassesPlugin);
const samples = new Map([
  ["object", "object Counter { count = 0; }"],
  ["final", "final class Base {}"],
  ["sealed", "sealed class Animal {}"],
  ["data", "data class Point(x: number, y: number);"],
  ["with", "const u2 = with(u1, { age: 21 });"],
  ["field", "get count() { return field; }"],
]);

// TypeScript's own grammar already highlights 'async' and 'class'
const highlightedByTypeScript = new Set(["async", "class"]);

test("highlights every declared editor keyword in context", () => {
  for (const keyword of getTSPPEditorKeywords(advancedClassesPlugin)) {
    if (highlightedByTypeScript.has(keyword)) continue;
    const sample = samples.get(keyword);
    if (!sample) throw new Error(`No grammar sample for declared keyword '${keyword}'.`);
    assertScoped(grammars, sample, keyword);
  }
});

test("highlights keywords with modifier combinations", () => {
  assertScoped(grammars, "class Foo { public field count = 0; }", "field");
  assertScoped(grammars, "class Foo { public static field count = 0; }", "field");
  assertScoped(grammars, "class Foo { public final execute() {} }", "final");
  assertScoped(grammars, "class Foo { final public execute() {} }", "final");
  assertScoped(grammars, "sealed abstract class Animal {}", "sealed");
  assertScoped(grammars, "final data class Point(x: number, y: number);", "data");
  assertScoped(grammars, "final data class Point(x: number, y: number);", "final");
  assertScoped(grammars, "class Counter { field count = 0 { get() { return field; } } }", "field");
  assertScoped(grammars, "object Loading extends NetworkResult { }", "extends");
  assertScoped(grammars, "object Loading implements IResult { }", "implements");
  assertScoped(grammars, "data class Success(msg: string) extends NetworkResult;", "extends");
  assertScoped(grammars, "data class Success(msg: string) implements IResult;", "implements");
  assertScoped(grammars, "sealed class Shape extends Base implements IShape {}", "extends");
  assertScoped(grammars, "sealed class Shape extends Base implements IShape {}", "implements");
});

test("leaves angle-bracket classification to TypeScript", () => assertLeavesAngleBracketsToTypeScript(grammars));
