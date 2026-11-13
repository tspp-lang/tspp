const path = require("node:path");
const fs = require("node:fs");
const unsupportedSdkMessage = "The selected TS++ SDK does not support tsppconfig.json. Rebuild or update the TS++ SDK.";

function isTsppConfig(fileName) {
  return /^tsppconfig(?:\..+)?\.json$/i.test(path.basename(fileName));
}

function compilerFile(sdkPath) {
  if (path.basename(sdkPath) === "tsserver.js") return path.join(path.dirname(sdkPath), "typescript.js");
  const direct = path.join(sdkPath, "typescript.js");
  return fs.existsSync(direct) ? direct : path.join(sdkPath, "lib", "typescript.js");
}

/** Use the compiler parser, including unsaved configuration and inherited configuration text. */
function configDiagnostics(ts, fileName, text, openFiles = new Map()) {
  if (typeof ts.createTSPPConfigHost !== "function") throw new Error(unsupportedSdkMessage);
  fileName = ts.normalizePath(fileName);
  const normalize = file => ts.sys.useCaseSensitiveFileNames ? path.resolve(file) : path.resolve(file).toLowerCase();
  const documents = new Map([...openFiles].map(([file, content]) => [normalize(file), content]));
  documents.set(normalize(fileName), text);
  const host = ts.createTSPPConfigHost({
    ...ts.sys,
    readFile: file => documents.get(normalize(file)) ?? ts.sys.readFile(file),
    fileExists: file => documents.has(normalize(file)) || ts.sys.fileExists(file),
  });
  const source = ts.readJsonConfigFile(fileName, host.readFile);
  const parsed = ts.parseJsonSourceFileConfigFileContent(source, host, path.dirname(fileName), undefined, fileName);
  const compilerHost = ts.createCompilerHost(parsed.options);
  compilerHost.readFile = host.readFile;
  compilerHost.fileExists = host.fileExists;
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options,
    host: ts.createTSPPConfigHost(compilerHost), projectReferences: parsed.projectReferences, configFileParsingDiagnostics: parsed.errors });
  return [...source.parseDiagnostics, ...parsed.errors, ...program.getOptionsDiagnostics()].filter((diagnostic, index, all) =>
    all.findIndex(candidate => candidate.code === diagnostic.code && candidate.start === diagnostic.start
      && candidate.length === diagnostic.length && candidate.file?.fileName === diagnostic.file?.fileName
      && ts.flattenDiagnosticMessageText(candidate.messageText, "\n") === ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")) === index);
}

function registerConfigDiagnostics(vscode, context, getCompiler) {
  const collection = vscode.languages.createDiagnosticCollection("TS++ configuration");
  const refresh = () => {
    const documents = vscode.workspace.textDocuments.filter(document => document.uri.scheme === "file");
    const configurations = documents.filter(document => isTsppConfig(document.fileName));
    if (!configurations.length) { collection.clear(); return; }
    const openFiles = new Map(documents.map(document => [document.fileName, document.getText()]));
    const byUri = new Map();
    const ts = getCompiler();
    if (typeof ts.createTSPPConfigHost !== "function") {
      collection.clear();
      for (const document of configurations) {
        const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), unsupportedSdkMessage, vscode.DiagnosticSeverity.Error);
        diagnostic.source = "TS++ configuration";
        collection.set(document.uri, [diagnostic]);
      }
      return;
    }
    for (const document of configurations) {
      for (const problem of configDiagnostics(ts, document.fileName, document.getText(), openFiles)) {
        const uri = problem.file ? vscode.Uri.file(problem.file.fileName) : document.uri;
        const start = problem.file?.getLineAndCharacterOfPosition(problem.start ?? 0) ?? { line: 0, character: 0 };
        const end = problem.file?.getLineAndCharacterOfPosition((problem.start ?? 0) + (problem.length ?? 0)) ?? start;
        const range = new vscode.Range(start.line, start.character, end.line, end.character);
        const diagnostic = new vscode.Diagnostic(range, ts.flattenDiagnosticMessageText(problem.messageText, "\n"),
          problem.category === ts.DiagnosticCategory.Warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
        diagnostic.code = problem.code;
        diagnostic.source = "TS++ configuration";
        const key = uri.toString();
        const group = byUri.get(key) ?? { uri, diagnostics: [] };
        group.diagnostics.push(diagnostic);
        byUri.set(key, group);
      }
    }
    collection.clear();
    for (const { uri, diagnostics } of byUri.values()) collection.set(uri, diagnostics);
  };
  let refreshTimer;
  const scheduleRefresh = () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  };
  const relevantFile = uri => /\.(?:json|tspp|[cm]?tsx?|[cm]?jsx?)$/i.test(uri.fsPath);
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(collection, watcher,
    { dispose: () => clearTimeout(refreshTimer) },
    vscode.workspace.onDidOpenTextDocument(document => { if (document.fileName.endsWith(".json")) scheduleRefresh(); }),
    vscode.workspace.onDidChangeTextDocument(event => { if (event.document.fileName.endsWith(".json")) scheduleRefresh(); }),
    vscode.workspace.onDidCloseTextDocument(document => { if (isTsppConfig(document.fileName) || document.fileName.endsWith(".json")) scheduleRefresh(); }),
    watcher.onDidCreate(uri => { if (relevantFile(uri)) scheduleRefresh(); }),
    watcher.onDidChange(uri => { if (uri.fsPath.endsWith(".json")) scheduleRefresh(); }),
    watcher.onDidDelete(uri => { if (relevantFile(uri)) scheduleRefresh(); }));
  refresh();
}

module.exports = { isTsppConfig, compilerFile, configDiagnostics, registerConfigDiagnostics };
