// End-to-end helpers for feature plugin tests: compile in-memory sources with the workspace compiler and the
// plugins under test registered, the same way the editor extension activates them.
const fs = require("node:fs");
const path = require("node:path");

function loadCompiler() {
  const root = path.dirname(require.resolve("ts-plus-plus/package.json", { paths: [__dirname] }));
  const development = path.join(root, "built", "local", "typescript.js");
  return require(fs.existsSync(development) ? development : path.join(root, "lib", "typescript.js"));
}

const ts = loadCompiler();

/** Registers each plugin's compiler facet for this test process; plugins stay active until it exits. */
function usePlugins(...plugins) {
  for (const plugin of plugins) ts.registerTSPPCompilerPlugin(plugin.default ?? plugin);
  return ts;
}

const defaultOptions = {
  noLib: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
};

/** Creates a program over in-memory files; `files` is one source text or a map from file name to text. */
function createProgram(files, options = {}) {
  const sources = typeof files === "string" ? { "/main.tspp": files } : files;
  const compilerOptions = { ...defaultOptions, ...options };
  const host = ts.createCompilerHost(compilerOptions);
  const outputs = new Map();
  Object.assign(host, {
    fileExists: fileName => fileName in sources,
    readFile: fileName => sources[fileName],
    getSourceFile: (fileName, languageVersion) => fileName in sources
      ? ts.createSourceFile(fileName, sources[fileName], languageVersion, /*setParentNodes*/ true)
      : undefined,
    writeFile: (fileName, text) => outputs.set(fileName, text),
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "/lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: fileName => fileName,
    directoryExists: () => true,
    getDirectories: () => [],
  });
  const program = ts.createProgram({ rootNames: Object.keys(sources), options: compilerOptions, host });
  return { program, outputs };
}

/** Syntactic and semantic diagnostics of the root files, flattened to message text. */
function diagnosticMessages(program) {
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()]
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

/** Emits the program and returns the JavaScript output, concatenated in file order. */
function emitJavaScript(program, outputs) {
  program.emit();
  return [...outputs].filter(([fileName]) => fileName.endsWith(".js")).map(([, text]) => text).join("\n");
}

/** Builds a language service over one in-memory file. */
function createLanguageService(fileName, source, options = {}) {
  const compilerOptions = { ...defaultOptions, ...options };
  return ts.createLanguageService({
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => "1",
    getScriptSnapshot: name => name === fileName ? ts.ScriptSnapshot.fromString(source) : undefined,
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => compilerOptions,
    getDefaultLibFileName: () => "/lib.d.ts",
    fileExists: name => name === fileName,
    readFile: name => name === fileName ? source : undefined,
  });
}

module.exports = { ts, usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService };
