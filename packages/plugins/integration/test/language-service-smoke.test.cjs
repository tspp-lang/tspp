// Asks the language service for everything an editor would, at every token of every example and fixture, and
// requires that nothing throws. Plugin syntax is lowered to synthetic nodes the services were not written for, so
// crashes hide in positions no hand-written test visits; the last diagnostics request catches state that earlier
// hovers or completions left inconsistent. Only crashes are checked here, not the answers. Set TSPP_SMOKE_DUMP to a
// file path to append every failure with a longer stack, which helps group them by cause.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { ts } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const examplesDirectory = path.resolve(__dirname, "../../../examples");
const fixturesDirectory = path.resolve(__dirname, "../fixtures");
const documentRegistry = ts.createDocumentRegistry();
const preferences = {
  includeCompletionsForModuleExports: true,
  includeCompletionsWithInsertText: true,
  includeInlayParameterNameHints: "all",
  includeInlayFunctionParameterTypeHints: true,
  includeInlayVariableTypeHints: true,
  includeInlayPropertyDeclarationTypeHints: true,
  includeInlayFunctionLikeReturnTypeHints: true,
  includeInlayEnumMemberValueHints: true,
};

/** A language service over files on disk, with every other file read through `ts.sys`. */
function createService(directory, fileNames, overrides = new Map()) {
  const configPath = path.join(directory, "tsconfig.json");
  const config = fs.existsSync(configPath)
    ? ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, directory).options
    : { strict: true, target: ts.ScriptTarget.ES2022 };
  // The plugins are already registered in this process.
  const options = { ...config, plugins: undefined, noEmit: true };
  const read = fileName => overrides.has(fileName) ? overrides.get(fileName) : ts.sys.readFile(fileName);
  const versions = new Map();
  const host = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: fileName => String(versions.get(fileName) ?? 0),
    getScriptSnapshot: fileName => {
      const text = read(fileName);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => directory,
    getCompilationSettings: () => options,
    getDefaultLibFileName: ts.getDefaultLibFilePath,
    fileExists: fileName => overrides.has(fileName) || ts.sys.fileExists(fileName),
    readFile: read,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };
  const service = ts.createLanguageService(host, documentRegistry);
  return {
    service,
    /** Replaces a file's text, as an editor does while the user types. */
    update(fileName, text) {
      overrides.set(fileName, text);
      versions.set(fileName, (versions.get(fileName) ?? 0) + 1);
    },
  };
}

function tokenSpans(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, /*skipTrivia*/ true, ts.LanguageVariant.Standard, text);
  const spans = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    spans.push({ start: scanner.getTokenStart(), end: scanner.getTokenEnd(), kind });
  }
  return spans;
}

/** Runs one request and records where it threw. */
function attempt(failures, fileName, text, position, request, run) {
  try {
    run();
  }
  catch (error) {
    const before = text.slice(0, position).split("\n");
    const [line, character] = [before.length - 1, before[before.length - 1].length];
    const reason = String(error?.stack ?? error).split("\n").slice(0, process.env.TSPP_SMOKE_DUMP ? 12 : 3).join(" | ");
    failures.push(`${path.relative(examplesDirectory, fileName)}:${line + 1}:${character + 1} ${request}: ${reason}`);
  }
}

function exercisePositions(service, fileName, text, failures) {
  for (const { start, end, kind } of tokenSpans(text)) {
    const at = (request, run, position = start) => attempt(failures, fileName, text, position, request, run);
    at("quick info", () => service.getQuickInfoAtPosition(fileName, start));
    at("definition", () => service.getDefinitionAndBoundSpan(fileName, start));
    at("type definition", () => service.getTypeDefinitionAtPosition(fileName, start));
    at("signature help", () => service.getSignatureHelpItems(fileName, end, undefined), end);
    at("document highlights", () => service.getDocumentHighlights(fileName, start, [fileName]));
    at("selection range", () => service.getSmartSelectionRange(fileName, start));
    at("brace matching", () => service.getBraceMatchingAtPosition(fileName, start));
    at("completions", () => {
      const completions = service.getCompletionsAtPosition(fileName, end, preferences);
      const entry = completions?.entries[0];
      if (entry) service.getCompletionEntryDetails(fileName, end, entry.name, ts.getDefaultFormatCodeSettings(), entry.source, preferences, entry.data);
    }, end);
    if (kind === ts.SyntaxKind.Identifier) {
      at("references", () => service.findReferences(fileName, start));
      at("rename", () => service.findRenameLocations(fileName, start, false, false, preferences));
      at("implementation", () => service.getImplementationAtPosition(fileName, start));
      at("refactors", () => service.getApplicableRefactors(fileName, { pos: start, end }, preferences));
    }
  }
}

function exerciseFile(service, fileName, text, failures) {
  const at = (request, run) => attempt(failures, fileName, text, 0, request, run);
  at("navigation tree", () => service.getNavigationTree(fileName));
  at("outlining spans", () => service.getOutliningSpans(fileName));
  at("semantic classifications", () => service.getEncodedSemanticClassifications(fileName, { start: 0, length: text.length }, ts.SemanticClassificationFormat.TwentyTwenty));
  at("syntactic classifications", () => service.getEncodedSyntacticClassifications(fileName, { start: 0, length: text.length }));
  at("inlay hints", () => service.provideInlayHints(fileName, { start: 0, length: text.length }, preferences));
  at("formatting", () => service.getFormattingEditsForDocument(fileName, ts.getDefaultFormatCodeSettings()));
}

function exerciseDiagnostics(service, fileName, text, failures) {
  let diagnostics = [];
  attempt(failures, fileName, text, 0, "diagnostics", () => {
    diagnostics = [
      ...service.getSyntacticDiagnostics(fileName),
      ...service.getSemanticDiagnostics(fileName),
      ...service.getSuggestionDiagnostics(fileName),
    ];
  });
  for (const diagnostic of diagnostics) {
    const start = diagnostic.start ?? 0;
    attempt(failures, fileName, text, start, `code fixes for TS${diagnostic.code}`, () =>
      service.getCodeFixesAtPosition(fileName, start, start + (diagnostic.length ?? 0), [diagnostic.code], ts.getDefaultFormatCodeSettings(), preferences));
  }
}

function report(failures) {
  if (process.env.TSPP_SMOKE_DUMP && failures.length) fs.appendFileSync(process.env.TSPP_SMOKE_DUMP, failures.join("\n") + "\n");
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} language service requests threw`);
}

function exampleProjects() {
  return fs.readdirSync(examplesDirectory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(examplesDirectory, entry.name, "package.json")))
    .map(entry => {
      const directory = path.join(examplesDirectory, entry.name);
      const sourceDirectory = path.join(directory, "src");
      const fileNames = fs.existsSync(sourceDirectory)
        ? fs.readdirSync(sourceDirectory).filter(name => /\.tspp$/.test(name)).map(name => path.join(sourceDirectory, name))
        : [];
      return { name: entry.name, directory, fileNames };
    })
    .filter(project => project.fileNames.length);
}

for (const project of exampleProjects()) {
  test(`language service requests never throw in example ${project.name}`, () => {
    const { service } = createService(project.directory, project.fileNames);
    const failures = [];
    for (const fileName of project.fileNames) {
      const text = fs.readFileSync(fileName, "utf8");
      exercisePositions(service, fileName, text, failures);
      exerciseFile(service, fileName, text, failures);
      exerciseDiagnostics(service, fileName, text, failures);
    }
    report(failures);
  });
}

const fixtureFileNames = fs.readdirSync(fixturesDirectory).filter(name => name.endsWith(".tspp")).map(name => path.join(fixturesDirectory, name));

test("language service requests never throw in fixtures with plugin errors", () => {
  const { service } = createService(fixturesDirectory, fixtureFileNames);
  const failures = [];
  for (const fileName of fixtureFileNames) {
    const text = fs.readFileSync(fileName, "utf8");
    exercisePositions(service, fileName, text, failures);
    exerciseFile(service, fileName, text, failures);
    exerciseDiagnostics(service, fileName, text, failures);
  }
  report(failures);
});

// While typing, the editor sees every prefix of a file. Cutting each source at several points reaches unfinished
// plugin syntax, where parsers recover in ways complete code never exercises.
test("language service requests never throw on partially typed sources", () => {
  const failures = [];
  const sources = [
    ...exampleProjects().flatMap(project => project.fileNames.map(fileName => ({ directory: project.directory, fileName }))),
    ...fixtureFileNames.map(fileName => ({ directory: fixturesDirectory, fileName })),
  ];
  for (const { directory, fileName } of sources) {
    const text = fs.readFileSync(fileName, "utf8");
    const { service, update } = createService(directory, [fileName]);
    const spans = tokenSpans(text);
    for (let cut = 1; cut <= 8; cut++) {
      const span = spans[Math.floor(spans.length * cut / 9)];
      if (!span) continue;
      const partial = text.slice(0, span.end);
      update(fileName, partial);
      const at = (request, run) => attempt(failures, fileName, partial, span.end, `${request} after a cut`, run);
      at("completions", () => service.getCompletionsAtPosition(fileName, span.end, preferences));
      at("quick info", () => service.getQuickInfoAtPosition(fileName, span.start));
      at("signature help", () => service.getSignatureHelpItems(fileName, span.end, undefined));
      exerciseDiagnostics(service, fileName, partial, failures);
    }
  }
  report(failures);
});
