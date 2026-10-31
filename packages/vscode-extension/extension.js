const path = require("node:path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let languageClient;
const activatedAnalysisPlugins = new Set();

function resolveSdkPath(context) {
  const configuredPath = vscode.workspace.getConfiguration("tspp").get("sdkPath", "").trim();
  if (configuredPath) {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return path.resolve(workspaceRoot ?? process.cwd(), configuredPath);
  }

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    // Pass the concrete file. The language server treats a directory as an SDK
    // root and normalizes it back to <package>/lib/tsserver.js, which would
    // silently select the stale LKG instead of the development build.
    return path.resolve(context.extensionPath, "../compiler/built/local/tsserver.js");
  }

  return path.dirname(require.resolve("ts-plus-plus/lib/tsserver.js"));
}

async function activate(context) {
  const serverModule = require.resolve("tspp-language-server");
  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  };
  const clientOptions = {
    documentSelector: [
      { scheme: "file", language: "tspp" },
      { scheme: "untitled", language: "tspp" },
    ],
    initializationOptions: {
      disableAutomaticTypingAcquisition: true,
      hostInfo: "vscode-tspp",
      tsserver: {
        path: resolveSdkPath(context),
        useSyntaxServer: "never",
      },
    },
  };

  languageClient = new LanguageClient("tspp", "TSPP Language Server", serverOptions, clientOptions);
  context.subscriptions.push(
    languageClient,
    vscode.commands.registerCommand("tspp.restartLanguageServer", () => languageClient?.restart()),
    vscode.commands.registerCommand("tspp.openLanguageServerLog", () => languageClient?.outputChannel.show()),
  );

  await languageClient.start();

  const expansionCache = new Map();
  const expandedDocuments = new Map();
  const expandedChanges = new vscode.EventEmitter();
  const selector = { language: "tspp", scheme: "file", pattern: "**/*.tspp" };

  async function analyze(document) {
    const key = `${document.uri}:${document.version}`;
    if (expansionCache.has(key)) return expansionCache.get(key);
    const pending = createMacroProgram(document).then(program => program?.getMacroExpansions?.(document.fileName) ?? [], () => []);
    expansionCache.set(key, pending);
    return pending;
  }

  async function createMacroProgram(document) {
    const sdkPath = resolveSdkPath(context);
    const compilerPath = sdkPath.endsWith("tsserver.js")
      ? path.join(path.dirname(sdkPath), "typescript.js")
      : require.resolve("ts-plus-plus");
    const ts = require(compilerPath);
    const pluginModule = require("@tspp/plugin-macros");
    ts.registerTSPPCompilerPlugin(pluginModule.default ?? pluginModule);
    const configPath = ts.findConfigFile(path.dirname(document.fileName), ts.sys.fileExists, "tsconfig.json");
    if (!configPath) return undefined;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) return undefined;
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
    const host = ts.createCompilerHost(parsed.options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, createNew) => {
      const open = vscode.workspace.textDocuments.find(candidate => candidate.uri.scheme === "file" && path.resolve(candidate.fileName).toLowerCase() === path.resolve(fileName).toLowerCase());
      return open
        ? ts.createSourceFile(fileName, open.getText(), languageVersion, true, ts.ScriptKind.TS)
        : originalGetSourceFile(fileName, languageVersion, onError, createNew);
    };
    const rootNames = parsed.fileNames.some(file => path.resolve(file).toLowerCase() === path.resolve(document.fileName).toLowerCase())
      ? parsed.fileNames
      : [...parsed.fileNames, document.fileName];
    return ts.createProgramAsync({ rootNames, options: parsed.options, host });
  }

  async function createAnalysisProgram(document) {
    const sdkPath = resolveSdkPath(context);
    const compilerPath = sdkPath.endsWith("tsserver.js")
      ? path.join(path.dirname(sdkPath), "typescript.js")
      : require.resolve("ts-plus-plus");
    const ts = require(compilerPath);
    const configPath = ts.findConfigFile(path.dirname(document.fileName), ts.sys.fileExists, "tsconfig.json");
    if (!configPath) return undefined;
    const config = ts.readConfigFile(configPath, ts.sys.readFile);
    if (config.error) return undefined;
    for (const entry of config.config.compilerOptions?.plugins ?? []) {
      if (!entry?.tspp || typeof entry.name !== "string") continue;
      const key = `${compilerPath}:${entry.name}`;
      if (activatedAnalysisPlugins.has(key)) continue;
      const modulePath = require.resolve(entry.name, { paths: [path.dirname(configPath), context.extensionPath] });
      const pluginModule = require(modulePath);
      ts.registerTSPPCompilerPlugin(pluginModule.default ?? pluginModule);
      activatedAnalysisPlugins.add(key);
    }
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(configPath), undefined, configPath);
    const host = ts.createCompilerHost(parsed.options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, languageVersion, onError, createNew) => {
      const open = vscode.workspace.textDocuments.find(candidate => candidate.uri.scheme === "file" && path.resolve(candidate.fileName).toLowerCase() === path.resolve(fileName).toLowerCase());
      return open
        ? ts.createSourceFile(fileName, open.getText(), languageVersion, true, ts.ScriptKind.TS)
        : originalGetSourceFile(fileName, languageVersion, onError, createNew);
    };
    const program = await ts.createProgramAsync({ rootNames: parsed.fileNames, options: parsed.options, host });
    await ts.runTSPPProgramAnalyzers(program);
    return { ts, program };
  }

  async function showAnalysisArtifacts(filter, emptyMessage) {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "tspp" || document.uri.scheme !== "file") return;
    try {
      const analysis = await createAnalysisProgram(document);
      const artifacts = (analysis?.ts.getTSPPAnalysisArtifacts?.(analysis.program, document.fileName) ?? [])
        .filter(filter)
        .sort((left, right) => left.start - right.start);
      if (!artifacts.length) {
        await vscode.window.showInformationMessage(emptyMessage);
        return;
      }
      let selected = artifacts;
      if (artifacts.length > 1) {
        const choices = [
          { label: "$(list-unordered) Show all artifacts", artifacts },
          ...artifacts.map(artifact => ({
            label: `$(file-code) ${artifact.name}`,
            description: artifact.status ?? "generated",
            detail: artifact.kind,
            artifacts: [artifact],
          })),
        ];
        const choice = await vscode.window.showQuickPick(choices, { placeHolder: "Choose a TS++ analysis artifact" });
        if (!choice) return;
        selected = choice.artifacts;
      }
      const content = selected
        .map((artifact, index) => `; [${index + 1}] ${artifact.name} — ${artifact.status ?? "generated"}\n${artifact.content}`)
        .join("\n");
      const artifactDocument = await vscode.workspace.openTextDocument({ language: selected[0].language, content });
      await vscode.window.showTextDocument(artifactDocument, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }
    catch (error) {
      await vscode.window.showErrorMessage(`Could not produce TS++ analysis artifacts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  context.subscriptions.push(
    expandedChanges,
    vscode.workspace.registerTextDocumentContentProvider("tspp-expanded", {
      onDidChange: expandedChanges.event,
      provideTextDocumentContent: uri => expandedDocuments.get(uri.toString()) ?? "",
    }),
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(document, position) {
        const offset = document.offsetAt(position);
        const expansion = (await analyze(document)).find(item => item.start <= offset && offset <= item.start + item.length);
        if (!expansion) return undefined;
        const markdown = new vscode.MarkdownString(`**TS++ macro expansion: \`${expansion.macroName}\`**\n\n`);
        if (expansion.text.trim()) markdown.appendCodeblock(expansion.text, "typescript");
        else markdown.appendMarkdown("This validation-only macro emits no statements.");
        return new vscode.Hover(markdown, new vscode.Range(document.positionAt(expansion.start), document.positionAt(expansion.start + expansion.length)));
      },
    }),
    vscode.commands.registerCommand("tspp.showExpandedSource", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || document.languageId !== "tspp" || document.uri.scheme !== "file") return;
      let text = document.getText();
      const expansions = [...await analyze(document)].sort((left, right) => right.start - left.start);
      if (!expansions.length) {
        await vscode.window.showInformationMessage("This file contains no compile-time macro invocations.");
        return;
      }
      for (const expansion of expansions) {
        text = text.slice(0, expansion.start) + expansion.text + text.slice(expansion.start + expansion.length);
      }
      const uri = vscode.Uri.from({ scheme: "tspp-expanded", path: document.uri.path.replace(/\.tspp$/i, ".expanded.tspp") });
      expandedDocuments.set(uri.toString(), text);
      expandedChanges.fire(uri);
      let expanded = await vscode.workspace.openTextDocument(uri);
      expanded = await vscode.languages.setTextDocumentLanguage(expanded, "tspp");
      await vscode.window.showTextDocument(expanded, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }),
    vscode.commands.registerCommand("tspp.showAnalysisArtifacts", async () => {
      await showAnalysisArtifacts(() => true, "This file has no plugin analysis artifacts.");
    }),
    vscode.commands.registerCommand("tspp.showSmtSource", async () => {
      await showAnalysisArtifacts(artifact => artifact.kind === "formal-verification/smt", "This file has no SMT source.");
    }),
    vscode.commands.registerCommand("tspp.showMlttNormalForms", async () => {
      await showAnalysisArtifacts(artifact => artifact.kind === "dependent-types/normal-form", "This file has no MLTT normal forms.");
    }),
    vscode.commands.registerCommand("tspp.showProjectedSource", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || document.languageId !== "tspp" || document.uri.scheme !== "file") return;
      const analysis = await createAnalysisProgram(document);
      if (!analysis) return;
      const content = analysis.ts.getTSPPProjectedSource(document.fileName, document.getText());
      const projected = await vscode.workspace.openTextDocument({ language: "typescript", content });
      await vscode.window.showTextDocument(projected, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }),
    vscode.commands.registerCommand("tspp.showActivePlugins", async () => {
      const document = vscode.window.activeTextEditor?.document;
      if (!document || document.languageId !== "tspp" || document.uri.scheme !== "file") return;
      const analysis = await createAnalysisProgram(document);
      if (!analysis) return;
      const plugins = analysis.ts.getRegisteredTSPPPlugins();
      const content = plugins.length
        ? plugins.map(plugin => [
          plugin.displayName ?? plugin.id,
          `  id: ${plugin.id}`,
          `  version: ${plugin.version}`,
          `  API: ${plugin.apiVersion}`,
          `  capabilities: ${plugin.capabilities?.join(", ") || "none declared"}`,
          `  requires: ${plugin.requires?.join(", ") || "none"}`,
          `  optional: ${plugin.optionalDependencies?.join(", ") || "none"}`,
        ].join("\n")).join("\n\n")
        : "No TS++ feature capsules are active.\n";
      const report = await vscode.workspace.openTextDocument({ language: "plaintext", content });
      await vscode.window.showTextDocument(report, { viewColumn: vscode.ViewColumn.Beside, preview: true });
    }),
    vscode.workspace.onDidChangeTextDocument(() => expansionCache.clear()),
    vscode.workspace.onDidSaveTextDocument(() => expansionCache.clear()),
  );
}

async function deactivate() {
  if (!languageClient) return;
  await languageClient.stop();
  languageClient = undefined;
}

module.exports = { activate, deactivate };
