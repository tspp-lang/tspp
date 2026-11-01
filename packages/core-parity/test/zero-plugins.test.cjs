// With no plugins loaded, the TS++ compiler must be upstream TypeScript (docs/core-restoration-plan.md, rule 5): no
// new keywords, no new syntax, the same diagnostics and the same output. Each sample compiles with both compilers.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const upstream = require("typescript-upstream");
const tsppRoot = path.dirname(require.resolve("ts-plus-plus/package.json"));
const tsppBuild = path.join(tsppRoot, "built", "local", "typescript.js");
if (!fs.existsSync(tsppBuild)) throw new Error(`Build the compiler first (pnpm build:compiler): ${tsppBuild} is missing.`);
const tspp = require(tsppBuild);

// Programs that are valid TypeScript, using the words TS++ plugins claim as plain identifiers.
const validSamples = {
  identifiers: `
    const macro = 1, data = 2, match = 3, def = 4, newtype = 5, typecase = 6, reify = 7, requires = 8;
    function with_(value: number) { return value; }
    export const total = macro + data + match + def + newtype + typecase + reify + requires + with_(1);
  `,
  generics: `
    interface Box<T> { value: T }
    type Unbox<B> = B extends Box<infer T> ? T : never;
    export function map<A, B>(box: Box<A>, f: (value: A) => B): Box<B> { return { value: f(box.value) }; }
    export const unboxed: Unbox<Box<string>> = map({ value: 1 }, n => n > 0 ? "yes" : "no").value;
  `,
  classes: `
    export abstract class Shape { abstract area(): number; static unit = 1; }
    export class Square extends Shape { constructor(private side: number) { super(); } area() { return this.side ** 2; } }
    export const area = new Square(2).area() + Shape.unit;
  `,
  control: `
    export function classify(value: number | string): string {
      switch (typeof value) { case "number": return value > 0 ? "positive" : "other"; default: return value; }
    }
    declare function each(f: (item: number) => number): void;
    each(_ => _ * 2);
    label: for (const item of [1, 2]) { if (item) continue label; }
  `,
};

// TS++ syntax that only a plugin may enable; without plugins each must fail exactly as upstream does.
const pluginSyntaxSamples = {
  macroFunction: `macro function named([target], context) { return target; }`,
  macroInvocation: `interface Account {}\nmacro named(Account);`,
  macroWith: `macro function slow() with { timeout: 1000; } { return undefined; }`,
  contract: `function clamp(value: number) with { requires: value >= 0; }: number { return value; }`,
  data: `data Shape = Circle(radius: number) | Square(side: number);`,
  newtype: `newtype UserId = number;`,
  match: `declare const shape: unknown;\nconst area = match shape { Circle(radius) => radius, _ => 0 };`,
  typeMatch: `type Selected<T> = match T { string: "text", _: "other" };`,
  typeLet: `type Pair = let P = <A> =>> [A, A] in P<number>;`,
  kindAnnotation: `type Apply<F: Type => Type, X> = F<X>;`,
  dependentAlias: `type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;`,
  typecase: `type Chosen: Type0 = typecase number { number: string, _: boolean };`,
  operatorSection: `const doubled = [1, 2].map((_ * 2));`,
  letIn: `const squared = let x = 2 in x * x;`,
  doExpression: `const total = do { const a = 1; a + 1 };`,
  def: `def frozen = { value: 1 };`,
  trailingClosure: `declare function run(f: () => void): void;\nrun() { };`,
  staticInterfaceMember: `interface Parser { static parse(text: string): number; }`,
  reify: `const described = reify<string>();`,
};

const options = (ts, target) => ({
  noLib: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  ...target,
});

function compile(ts, source) {
  const fileName = "/main.ts";
  const compilerOptions = options(ts);
  const outputs = {};
  const host = ts.createCompilerHost(compilerOptions);
  Object.assign(host, {
    fileExists: name => name === fileName,
    readFile: name => name === fileName ? source : undefined,
    getSourceFile: (name, languageVersion) =>
      name === fileName ? ts.createSourceFile(name, source, languageVersion, /*setParentNodes*/ true) : undefined,
    writeFile: (name, text) => { outputs[name] = text; },
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "/lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: name => name,
    directoryExists: () => true,
    getDirectories: () => [],
  });
  const program = ts.createProgram({ rootNames: [fileName], options: compilerOptions, host });
  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getDeclarationDiagnostics(),
  ].map(diagnostic => ({
    code: diagnostic.code,
    start: diagnostic.start,
    length: diagnostic.length,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
  program.emit();
  return { diagnostics, outputs };
}

for (const [name, source] of Object.entries(validSamples)) {
  test(`valid TypeScript compiles exactly as upstream: ${name}`, () => {
    const expected = compile(upstream, source);
    assert.deepEqual(compile(tspp, source), expected);
    // Global types are missing under noLib; anything else means the sample itself is not valid TypeScript.
    assert.deepEqual(expected.diagnostics.filter(diagnostic => diagnostic.code !== 2318), []);
  });
}

// Syntax still built into the core. Each entry goes away when its plugin migrates (phase 2 of the plan); the test
// fails once a sample matches upstream so that the entry is removed rather than left to hide a regression.
const knownViolations = {
  macroFunction: "macros: the `macro` keyword is core syntax",
  macroInvocation: "macros: `MacroInvocationStatement` is core syntax",
  macroWith: "macros: the `with` clause is core syntax",
  contract: "macros and formal-verification: the `with` clause is core syntax",
};

for (const [name, source] of Object.entries(pluginSyntaxSamples)) {
  test(`plugin syntax stays inactive without plugins: ${name}`, () => {
    const expected = compile(upstream, source);
    assert.ok(expected.diagnostics.some(diagnostic => diagnostic.code !== 2318), "upstream accepts the sample");
    if (name in knownViolations) {
      assert.notDeepEqual(compile(tspp, source), expected, `Fixed: remove '${name}' from knownViolations.`);
    }
    else {
      assert.deepEqual(compile(tspp, source), expected);
    }
  });
}
