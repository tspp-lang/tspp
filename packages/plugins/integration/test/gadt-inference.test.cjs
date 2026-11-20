// Constructor inference flows from explicit result types and sibling arguments.
// It must not invent type-family inverses or infer from later statements.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const { ts, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const exampleRoot = path.resolve(__dirname, "../../../examples/10-dependent-types/src");
const read = name => fs.readFileSync(path.join(exampleRoot, name), "utf8");
const basic = read("10-gadt-interpreter.tspp");
const context = read("11-context-interpreter.tspp");
const standalone = read("12-well-typed-interpreter.tspp");
const options = { noLib: false, lib: ["lib.es2022.d.ts"] };
const libraryEnd = standalone.indexOf("// \\x. \\y. y + x");
assert.ok(libraryEnd > 0, "The standalone interpreter's declaration section was not found");
const library = standalone.slice(0, libraryEnd);

function replaceSection(source, start, end, replacement) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Cannot locate example section ${start}`);
  return source.slice(0, from) + replacement + "\n\n" + source.slice(to);
}

function compile(source, extraFiles = {}) {
  return createProgram({ ...extraFiles, "/main.tspp": source }, options);
}

function run(source, extraFiles = {}) {
  const { program, outputs } = compile(source, extraFiles);
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const javaScript = outputs.get("/main.js");
  assert.ok(javaScript, "The inferred constructor program emitted no JavaScript");
  const exports = {};
  vm.runInThisContext(`(function (exports, module) {\n${javaScript}\n})`)(exports, { exports });
  return exports;
}

function languageService(source) {
  const fileName = "/main.tspp";
  const compilerOptions = { ...options, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS };
  const readFile = name => name === fileName ? source : ts.sys.readFile(name);
  return ts.createLanguageService({
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => "1",
    getScriptSnapshot: name => {
      const text = readFile(name);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: settings => ts.getDefaultLibFilePath(settings),
    fileExists: name => name === fileName || ts.sys.fileExists(name),
    readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
  });
}

const add = `// \\x. \\y. y + x
export const add: Expr<readonly [], Fun<"int", Fun<"int", "int">>> = Lam(Lam(Op(
    (left, right) => left + right,
    Var(Stop()),
    Var(Pop(Stop()))
)));`;

const factorial = `export function factorial<C extends Context>(): Expr<C, Fun<"int", "int">> {
    type Body = readonly ["int", ...C];
    const argument: Expr<Body, "int"> = Var(Stop());
    return Lam(If(
        Op((left, right) => left === right, argument, Val(0n)),
        Val(1n),
        Op(
            (left, right) => left * right,
            App(
                Delay(() => factorial<Body>()),
                Op((left, right) => left - right, argument, Val(1n))
            ),
            argument
        )
    ));
}`;

test("an annotated host-function expression contextually types its callback", () => {
  const source = replaceSection(
    basic,
    "const isZero",
    "export const integerResult:",
    'const isZero: Expr<Fun<"int", "bool">> = Host(value => value === 0n);',
  );
  const exports = run(source);
  assert.equal(exports.integerResult, 42n);
  assert.equal(exports.booleanResult, true);
});

test("annotated nested lambdas infer operators, variable proofs, and readonly context tails", () => {
  for (const template of [context, standalone]) {
    const source = replaceSection(template, "// \\x. \\y. y + x", "export const additionResult:", add);
    const exports = run(source, { "/10-gadt-interpreter.tspp": basic });
    assert.equal(exports.additionResult, 42n);
    assert.equal(exports.factorialResult, 720n);
  }
});

test("an annotated recursive function infers constructor arguments with one typed variable expression", () => {
  const source = replaceSection(standalone, "export function factorial<", "export const factorialResult:", factorial);
  const exports = run(source);
  assert.equal(exports.factorialResult, 720n);
  assert.equal(exports.dynamicInteger.value, 720n);
  assert.equal(exports.dynamicBoolean.value, true);
  assert.equal(exports.dynamicFunction.value(5n), 120n);
});

test("contextual result types and sibling expressions infer nullary proofs and operator callbacks", () => {
  const source = `${library}
    export const first: HasType<readonly ["int", "bool"], "int"> = Stop();
    export const second: HasType<readonly ["int", "bool"], "bool"> = Pop(Stop());
    export const sum: Expr<readonly [], "int"> = Op((left, right) => left + right, Val(20n), Val(22n));
    export const answer: bigint = interp(Nil, sum);
  `;
  const exports = run(source);
  assert.equal(exports.answer, 42n);
});

test("expected result types never excuse wrong constructor arguments or union widening", () => {
  for (const invalid of [
    'export const bad: Expr<readonly [], "int"> = If(BoolVal(true), Val(1n), BoolVal(false));',
    `declare const predicate: Expr<readonly [], Fun<"int", "bool">>;
     export const bad: Expr<readonly [], "bool"> = App(predicate, BoolVal(true));`,
    'export const bad: Expr<readonly [], "int"> = Var(Stop());',
    'export const bad: Expr<readonly [], "bool"> = Op((left, right) => left + right, Val(1n), Val(2n));',
    'export const bad: Expr<readonly [], Fun<"int", "bool">> = Lam(Val(1n));',
  ]) {
    const diagnostics = diagnosticMessages(compile(`${library}\n${invalid}`).program);
    assert.ok(diagnostics.length > 0, `Invalid constructor inference was accepted:\n${invalid}`);
  }
});

test("a noninjective type family needs an expected index or an explicit argument", () => {
  const source = `
    type Kind = "int" | "bool";
    type Erase<T extends Kind> = bigint;
    data Wrapped<T extends Kind> { Wrap: <T extends Kind>(value: Erase<T>) => Wrapped<T>, }
    export const contextual: Wrapped<"int"> = Wrap(1n);
    export const explicit = Wrap<"bool">(2n);
  `;
  assert.deepEqual(diagnosticMessages(compile(source).program), []);
  const diagnostics = diagnosticMessages(compile(`${source}
    const ambiguous = Wrap(3n);
    export const guessed: Wrapped<"int"> = ambiguous;
  `).program);
  assert.ok(diagnostics.length > 0, "The erased family was inverted to guess an index");
});

test("constructor inference does not flow backward from another statement", () => {
  const diagnostics = diagnosticMessages(compile(`${library}
    const proof = Stop();
    export const later: HasType<readonly ["int"], "int"> = proof;
  `).program);
  assert.ok(diagnostics.length > 0, "An unconstrained proof was specialized by a later assignment");
});

test("hovering nested constructors before diagnostics preserves contextual inference", () => {
  const addStart = standalone.indexOf("// \\x. \\y. y + x");
  const lambda = standalone.indexOf("Lam(Lam(Op(", addStart) + 4;
  const positions = {
    Lam: lambda,
    Stop: standalone.indexOf("Stop()", lambda),
    Pop: standalone.indexOf("Pop(Stop())", lambda),
    left: standalone.indexOf("(left, right)", lambda) + 1,
  };
  for (const [name, position] of Object.entries(positions)) {
    assert.equal(standalone.slice(position, position + name.length), name, `Missing ${name} hover target`);
  }
  // A fresh service makes the innermost name or callback the first checker request.
  for (const order of [["Lam", "Stop", "Pop", "left"], ["Stop", "Pop", "left", "Lam"], ["left", "Pop", "Stop", "Lam"]]) {
    const service = languageService(standalone);
    try {
      for (const name of order) {
        const info = service.getQuickInfoAtPosition("/main.tspp", positions[name]);
        assert.ok(info, `No quick info for ${name} in order ${order}`);
        if (name === "left") assert.match(ts.displayPartsToString(info.displayParts), /left: bigint/);
      }
      const program = service.getProgram();
      assert.ok(program, "The language service produced no program");
      assert.deepEqual(diagnosticMessages(program), [], `Hover order: ${order}`);
    }
    finally {
      service.dispose();
    }
  }
});

test("imported rich-declaration constructors infer annotated nested expressions", () => {
  const { program, outputs } = createProgram({ "/lib/interpreter.tspp": standalone }, { ...options, declaration: true, emitDeclarationOnly: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const declarations = [...outputs].find(([name]) => name.endsWith(".d.tspp"))?.[1];
  assert.ok(declarations, "The interpreter emitted no rich declarations");
  const consumer = `
    import { Expr, Fun, Lam, Nil, Op, Pop, Stop, Var, interp } from "./lib/interpreter";
    export const add: Expr<readonly [], Fun<"int", Fun<"int", "int">>> = Lam(Lam(Op(
      (left, right) => left + right,
      Var(Stop()),
      Var(Pop(Stop()))
    )));
    export const answer: bigint = interp(Nil, add)(20n)(22n);
  `;
  const files = { "/lib/interpreter.d.tspp": declarations, "/main.tspp": consumer };
  assert.deepEqual(diagnosticMessages(createProgram(files, options).program), []);
  files["/main.tspp"] = consumer.replace("left + right", '"wrong"');
  assert.ok(diagnosticMessages(createProgram(files, options).program).length > 0, "An imported constructor accepted the wrong operator result");
});
