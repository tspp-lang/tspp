// Emits declarations for a library that uses the plugins, then type-checks consumers that see only those files.
// Single-file tests only match the emitted text; a declaration that loses a brand, a kind, or a lowered type still
// looks plausible there and only fails once another package depends on it.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { ts, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const library = `
export newtype UserId = number;
export data Result<T> = Ok(value: T) | Err(error: string);
export type Box<T> = { value: T };
export type Apply<F: Type => Type, X> = F<X>;
export type Wrap = <T> =>> { wrapped: T };
export type Twice<T> = let X = { value: T } in [X, X];
export type Classify<T> = match T { string: "text", _: "other" };
export data Term = Term(pair: let X = string in [X, X], size: (x: Nat) -> Nat);
export newtype Label = let X = string in X;
export interface Parser {
    static parse(text: string): number;
}
export function makeId(value: number): UserId { return UserId(value); }
`;

function emitLibrary() {
  const { program, outputs } = createProgram({ "/lib/index.tspp": library }, { declaration: true, emitDeclarationOnly: true });
  assert.deepEqual(diagnosticMessages(program), []);
  program.emit();
  const read = extension => [...outputs].find(([fileName]) => fileName.endsWith(extension))?.[1];
  return { tspp: read(".d.tspp"), typescript: read(".d.ts") };
}

const consumerMessages = (declarations, consumer) =>
  diagnosticMessages(createProgram({ "/lib/index.d.tspp": declarations, "/main.tspp": consumer }).program);

test("TS++ declarations keep nominal types, data types, kinds, and computed types for consumers", () => {
  const { tspp } = emitLibrary();
  assert.ok(tspp, "no .d.tspp was emitted");
  const imports = `import { Apply, Box, Classify, Err, Label, makeId, Ok, Parser, Result, Term, Twice, UserId, Wrap } from "./lib/index";\n`;
  assert.deepEqual(consumerMessages(tspp, `${imports}
    const id: UserId = makeId(1);
    const plain: number = id;
    const result: Result<number> = Ok(1);
    const selected: number = match result { Ok(value) => value, Err(error) => error === "" ? 0 : 1 };
    const applied: Apply<Box, string> = { value: "x" };
    const wrapped: Wrap<number> = { wrapped: 1 };
    const twice: Twice<number> = [{ value: 1 }, { value: 2 }];
    const classified: Classify<"a"> = "text";
    class NumberParser implements Parser { static parse(text: string): number { return text === "" ? 0 : 1; } }
    declare const term: Term;
    const pair: [string, string] = term.pair;
    const label: string = Label("x");
    void [plain, selected, applied, wrapped, twice, classified, NumberParser, Err, pair, label];
  `), []);

  const errors = consumerMessages(tspp, `${imports}
    const forged: UserId = 1;
    declare const result: Result<number>;
    const partial = match result { Ok(value) => value };
    type WrongKind = Apply<number, string>;
    const badWrap: Wrap<number> = { wrapped: "x" };
    const badTwice: Twice<number> = [{ value: 1 }, { value: "x" }];
    const badClass: Classify<1> = "text";
    class TextParser implements Parser { static parse(text: string): string { return text; } }
    declare const badTerm: Term;
    const badPair: [number, number] = badTerm.pair;
    void [forged, partial, badWrap, badTwice, badClass, TextParser, makeId, Err, Box, Label, badPair];
  `).join("\n");
  assert.match(errors, /Type 'number' is not assignable to type 'UserId'/);
  assert.match(errors, /Type 'string' is not assignable to type 'number'/);
  assert.match(errors, /Non-exhaustive match\. Missing patterns: Err/);
  assert.match(errors, /Type 'number' has kind 'Type', but kind 'Type => Type' was expected/);
  assert.match(errors, /Type 'string' is not assignable to type 'number'/);
  assert.match(errors, /Type '"text"' is not assignable to type '"other"'/);
  assert.match(errors, /Class static side 'typeof TextParser' incorrectly implements|static side .*TextParser|'parse'/);
});

test("compatibility declarations are plain TypeScript that upstream TypeScript can consume", () => {
  const { typescript } = emitLibrary();
  assert.ok(typescript, "no .d.ts was emitted");
  const upstream = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "../../..")] }));
  assert.notEqual(upstream.version, ts.version);
  const sources = {
    "/lib/index.d.ts": typescript,
    "/main.ts": `import { makeId, Ok, Result, UserId } from "./lib/index";
      const id: UserId = makeId(1);
      const result: Result<number> = Ok(1);
      void [id, result];`,
  };
  const options = { noLib: true, strict: true, noEmit: true };
  const host = upstream.createCompilerHost(options);
  Object.assign(host, {
    fileExists: fileName => fileName in sources,
    readFile: fileName => sources[fileName],
    getSourceFile: (fileName, languageVersion) =>
      fileName in sources ? upstream.createSourceFile(fileName, sources[fileName], languageVersion) : undefined,
    getCurrentDirectory: () => "/",
  });
  const program = upstream.createProgram({ rootNames: Object.keys(sources), options, host });
  const messages = [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .map(diagnostic => upstream.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  assert.deepEqual(messages, [], typescript);
});
