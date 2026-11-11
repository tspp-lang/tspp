const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { ts } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const project = path.resolve(__dirname, "..", "..", "formal-verification");
const fixture = path.join(project, "src", "program-index-keys.test.tspp");
const config = ts.getParsedCommandLineOfConfigFile(path.join(project, "tsconfig.json"), { noEmit: true }, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  },
});
assert.deepEqual(config.errors, []);

const declarations = `
import { rangeKey, declarationKey, type SourceRangeKey, type DeclarationKey, type ModeledFile, type ProgramIndex } from "./program-index";
import type { CallResolver } from "./call-targets";
import type { Context, State } from "./execution-state";
declare const file: ModeledFile;
declare const index: ProgramIndex;
declare const resolver: CallResolver;
declare const context: Context;
declare const state: State;
const range: SourceRangeKey = rangeKey(1, 3);
const declaration: DeclarationKey = declarationKey("file.tspp", 1);
const plain: string = "1:3";
`;

function diagnosticsFor(source) {
  const host = ts.createCompilerHost(config.options);
  const canonical = file => host.getCanonicalFileName(path.resolve(file));
  const isFixture = file => canonical(file) === canonical(fixture);
  const readFile = host.readFile;
  const fileExists = host.fileExists;
  const getSourceFile = host.getSourceFile;
  host.readFile = file => isFixture(file) ? source : readFile(file);
  host.fileExists = file => isFixture(file) || fileExists(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => isFixture(file)
    ? ts.createSourceFile(file, source, languageVersion, /*setParentNodes*/ true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  // Each case checks a fresh program against the actual project sources and their exported key types.
  const program = ts.createProgram({
    rootNames: [...config.fileNames, fixture],
    options: config.options,
    projectReferences: config.projectReferences,
    host,
  });
  return ts.getPreEmitDiagnostics(program);
}

function describe(diagnostics) {
  return diagnostics.map(diagnostic => {
    const file = diagnostic.file ? path.relative(project, diagnostic.file.fileName) : "project";
    return `${file} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  }).join("\n");
}

test("program index keys preserve their string values and look up their matching maps", () => {
  const { rangeKey, declarationKey } = require("../../formal-verification/dist/program-index");
  assert.equal(rangeKey(1, 3), "1:3");
  assert.equal(declarationKey("file.tspp", 1), "file.tspp:1");
  const diagnostics = diagnosticsFor(`${declarations}
file.callTargets?.get(range);
file.classAncestry?.get(range);
index.declarations.get(declaration);
resolver.callTargets?.get(range);
resolver.declarations.get(declaration);
context.callTargets?.get(range);
context.declarations.get(declaration);
index.files.get("file.tspp");
file.functions.get("name");
state.declarations.add(plain);
`);
  assert.equal(diagnostics.length, 0, describe(diagnostics));
});

test("program index maps reject swapped key types and ordinary strings at their lookup arguments", () => {
  const calls = [
    "file.callTargets?.get(declaration)",
    "file.classAncestry?.get(declaration)",
    "index.declarations.get(range)",
    "resolver.callTargets?.get(declaration)",
    "resolver.declarations.get(range)",
    "context.callTargets?.get(declaration)",
    "context.declarations.get(range)",
  ].flatMap(call => [call, call.replace(/\((?:declaration|range)\)$/, "(plain)")]);
  const source = `${declarations}\n${calls.map(call => `${call};`).join("\n")}\n`;
  const spans = calls.map(call => {
    const start = source.indexOf(call) + call.indexOf("(") + 1;
    return { start, length: call.lastIndexOf(")") - call.indexOf("(") - 1 };
  });
  const diagnostics = diagnosticsFor(source);
  const message = describe(diagnostics);
  assert.equal(diagnostics.length, spans.length, message);
  for (const diagnostic of diagnostics) {
    assert.equal(diagnostic.code, 2345, message);
    assert.equal(path.resolve(diagnostic.file.fileName), fixture, message);
    assert.equal(diagnostic.file.text, source);
    assert.ok(spans.some(span => diagnostic.start === span.start && diagnostic.length === span.length), message);
  }
  for (const span of spans) {
    assert.ok(diagnostics.some(diagnostic => diagnostic.start === span.start && diagnostic.length === span.length),
      `Missing diagnostic on ${source.slice(span.start, span.start + span.length)}.\n${message}`);
  }
});
