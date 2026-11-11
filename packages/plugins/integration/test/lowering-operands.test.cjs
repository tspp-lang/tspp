const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { ts } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const project = path.resolve(__dirname, "..", "..", "type-computation");
const lowerFile = path.join(project, "src", "lower.tspp");
const original = fs.readFileSync(lowerFile, "utf8");
const config = ts.getParsedCommandLineOfConfigFile(path.join(project, "tsconfig.json"), { noEmit: true }, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic(diagnostic) {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  },
});
assert.deepEqual(config.errors, []);
assert.ok(config.fileNames.some(file => path.resolve(file) === lowerFile));

function diagnosticsFor(source) {
  // A new host and program keep each mutation's source tree separate from the previous check.
  const host = ts.createCompilerHost(config.options);
  const canonical = file => host.getCanonicalFileName(path.resolve(file));
  const isLowerFile = file => canonical(file) === canonical(lowerFile);
  const readFile = host.readFile;
  const getSourceFile = host.getSourceFile;
  host.readFile = file => isLowerFile(file) ? source : readFile(file);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => isLowerFile(file)
    ? ts.createSourceFile(file, source, languageVersion, /*setParentNodes*/ true)
    : getSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    projectReferences: config.projectReferences,
    host,
  });
  return ts.getPreEmitDiagnostics(program);
}

function describe(diagnostics) {
  return diagnostics.map(diagnostic => {
    const location = diagnostic.file && diagnostic.start !== undefined
      ? `${path.relative(project, diagnostic.file.fileName)}:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
      : "project";
    return `${location} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
  }).join("\n");
}

const naturalCall = 'case "nat-add": return lowerNatural(current, ["left", "right"], scope);';
const mutations = [
  {
    name: "rejects a missing right operand in the actual natural-number lowering call",
    changes: [{
      before: naturalCall,
      after: 'case "nat-add": return lowerNatural(current, ["left"], scope);',
      expression: '["left"]',
    }],
  },
  {
    name: "rejects a duplicated left operand in the actual natural-number lowering call",
    changes: [{
      before: naturalCall,
      after: 'case "nat-add": return lowerNatural(current, ["left", "left"], scope);',
      expression: '["left", "left"]',
    }],
  },
  {
    name: "rejects swapped natural and identity eliminator operand fields in the actual lowering calls",
    changes: [
      {
        before: 'case "nat-elim": return lowerReduced(current, "scrutinee", scope);',
        after: 'case "nat-elim": return lowerReduced(current, "equality", scope);',
        expression: '"equality"',
      },
      {
        before: 'case "identity-elim": return lowerReduced(current, "equality", scope);',
        after: 'case "identity-elim": return lowerReduced(current, "scrutinee", scope);',
        expression: '"scrutinee"',
      },
    ],
  },
];

test("checks lowering operand constraints against the real project sources", async t => {
  await t.test("the unmodified project has no diagnostics", () => {
    const diagnostics = diagnosticsFor(original);
    assert.equal(diagnostics.length, 0, describe(diagnostics));
  });
  for (const { name, changes } of mutations) {
    await t.test(name, () => {
      let source = original;
      for (const { before, after } of changes) {
        assert.ok(source.includes(before), `Missing lowering call: ${before}`);
        assert.equal(source.indexOf(before), source.lastIndexOf(before), `Ambiguous lowering call: ${before}`);
        source = source.replace(before, after);
      }
      const spans = changes.map(({ after, expression }) => {
        const start = source.indexOf(after) + after.indexOf(expression);
        return { start, end: start + expression.length };
      });
      const diagnostics = diagnosticsFor(source);
      const message = describe(diagnostics);
      assert.ok(diagnostics.length >= spans.length, message || "The invalid lowering calls compiled without diagnostics.");
      for (const diagnostic of diagnostics) {
        assert.ok(diagnostic.code === 2322 || diagnostic.code === 2345, message);
        assert.equal(path.resolve(diagnostic.file.fileName), lowerFile, message);
        assert.equal(diagnostic.file.text, source, "The compiler must check the mutated source tree.");
        assert.ok(spans.some(span => diagnostic.start >= span.start && diagnostic.start + diagnostic.length <= span.end), message);
      }
      for (const span of spans) {
        assert.ok(diagnostics.some(diagnostic => diagnostic.start >= span.start && diagnostic.start + diagnostic.length <= span.end),
          `Missing diagnostic on ${source.slice(span.start, span.end)}.\n${message}`);
      }
    });
  }
});
