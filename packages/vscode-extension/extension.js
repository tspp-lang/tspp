const path = require("node:path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let languageClient;

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
}

async function deactivate() {
  if (!languageClient) return;
  await languageClient.stop();
  languageClient = undefined;
}

module.exports = { activate, deactivate };
