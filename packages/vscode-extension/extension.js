const path = require("node:path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");
const { getCodeDecorationSpans } = require("@tspp/plugin-sdk/editor");

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
  const unreachableDecoration = vscode.window.createTextEditorDecorationType({ opacity: "0.667" });
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

  function updateUnreachableDecorations(editor) {
    if (!editor || editor.document.languageId !== "tspp") return;
    const document = editor.document;
    const ranges = vscode.languages.getDiagnostics(document.uri)
      .filter(diagnostic => Number(diagnostic.code) === 7027)
      .flatMap(diagnostic => getCodeDecorationSpans(document.getText(), {
        start: document.offsetAt(diagnostic.range.start),
        length: document.offsetAt(diagnostic.range.end) - document.offsetAt(diagnostic.range.start),
      }))
      .map(span => new vscode.Range(
        document.positionAt(span.start),
        document.positionAt(span.start + span.length),
      ));
    editor.setDecorations(unreachableDecoration, ranges);
  }

  function updateVisibleUnreachableDecorations(uri) {
    for (const editor of vscode.window.visibleTextEditors) {
      if (!uri || editor.document.uri.toString() === uri.toString()) updateUnreachableDecorations(editor);
    }
  }

  context.subscriptions.push(
    unreachableDecoration,
    vscode.languages.onDidChangeDiagnostics(event => {
      for (const uri of event.uris) updateVisibleUnreachableDecorations(uri);
    }),
    vscode.window.onDidChangeVisibleTextEditors(() => updateVisibleUnreachableDecorations()),
  );
  updateVisibleUnreachableDecorations();

  const expansionCache = new Map();
  const programCache = new Map();
  const analysisCache = new Map();
  const previewDocuments = new Map();
  const previewChanges = new vscode.EventEmitter();
  const selector = { language: "tspp", scheme: "file", pattern: "**/*.tspp" };

  function getPreviewUri(document, kind, language) {
    const extensions = {
      json: "json",
      markdown: "md",
      plaintext: "txt",
      typescript: "ts",
      tspp: "tspp",
    };
    const extension = extensions[language] ?? "txt";
    const sourcePath = document.uri.path.replace(/\.tspp$/i, "");
    return vscode.Uri.from({ scheme: "tspp-preview", path: `${sourcePath}.${kind}.${extension}` });
  }

  async function showReadonlyPreview(document, kind, language, content) {
    const uri = getPreviewUri(document, kind, language);
    previewDocuments.set(uri.toString(), content);
    previewChanges.fire(uri);
    let preview = await vscode.workspace.openTextDocument(uri);
    if (preview.languageId !== language) preview = await vscode.languages.setTextDocumentLanguage(preview, language);
    await vscode.window.showTextDocument(preview, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }

  function withProgress(title, task) {
    return vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: false,
    }, task);
  }

  async function analyze(document) {
    const key = `${document.uri}:${document.version}`;
    if (expansionCache.has(key)) return expansionCache.get(key);
    const pending = createProgram(document).then(
      result => result?.program.getMacroExpansions?.(document.fileName) ?? [],
      () => [],
    );
    expansionCache.set(key, pending);
    return pending;
  }

  async function createProgram(document) {
    const cacheKey = `${document.uri}:${document.version}`;
    if (programCache.has(cacheKey)) return programCache.get(cacheKey);
    const pending = createProgramWorker(document);
    programCache.set(cacheKey, pending);
    try { return await pending; }
    catch (error) { programCache.delete(cacheKey); throw error; }
  }

  async function createProgramWorker(document) {
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
    const rootNames = parsed.fileNames.some(file => path.resolve(file).toLowerCase() === path.resolve(document.fileName).toLowerCase())
      ? parsed.fileNames
      : [...parsed.fileNames, document.fileName];
    const program = await ts.createProgramAsync({ rootNames, options: parsed.options, host });
    return { ts, program };
  }

  async function createAnalysisProgram(document) {
    const cacheKey = `${document.uri}:${document.version}`;
    if (analysisCache.has(cacheKey)) return analysisCache.get(cacheKey);
    const pending = createAnalysisProgramWorker(document);
    analysisCache.set(cacheKey, pending);
    try { return await pending; }
    catch (error) { analysisCache.delete(cacheKey); throw error; }
  }

  async function createAnalysisProgramWorker(document) {
    const result = await createProgram(document);
    if (!result) return undefined;
    await result.ts.runTSPPProgramAnalyzers(result.program);
    return result;
  }

  async function showAnalysisArtifacts(filter, emptyMessage) {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "tspp" || document.uri.scheme !== "file") return;
    try {
      const analysis = await withProgress("TS++: Generating analysis artifacts…", () => createAnalysisProgram(document));
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
      await showReadonlyPreview(document, "analysis", selected[0].language, content);
    }
    catch (error) {
      await vscode.window.showErrorMessage(`Could not produce TS++ analysis artifacts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  context.subscriptions.push(
    previewChanges,
    vscode.workspace.registerTextDocumentContentProvider("tspp-preview", {
      onDidChange: previewChanges.event,
      provideTextDocumentContent: uri => previewDocuments.get(uri.toString()) ?? "",
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
      const expansions = [...await withProgress("TS++: Generating macro expansion…", () => analyze(document))];
      if (!expansions.length) {
        await vscode.window.showInformationMessage("This file contains no compile-time macro invocations.");
        return;
      }
      let text = document.getText();
      expansions.sort((left, right) => right.start - left.start);
      for (const expansion of expansions) {
        text = text.slice(0, expansion.start) + expansion.text + text.slice(expansion.start + expansion.length);
      }
      await showReadonlyPreview(document, "expanded", "tspp", text);
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
      const result = await withProgress("TS++: Generating projected TypeScript…", () => createProgram(document));
      if (!result) return;
      const content = result.ts.getTSPPProjectedSource(document.fileName, document.getText());
      await showReadonlyPreview(document, "projected", "typescript", content);
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
    vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.scheme !== "file" || event.document.languageId !== "tspp") return;
      expansionCache.clear();
      programCache.clear();
      analysisCache.clear();
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.scheme !== "file" || document.languageId !== "tspp") return;
      expansionCache.clear();
      programCache.clear();
      analysisCache.clear();
    }),
  );
}

async function deactivate() {
  if (!languageClient) return;
  await languageClient.stop();
  languageClient = undefined;
}

module.exports = { activate, deactivate };
