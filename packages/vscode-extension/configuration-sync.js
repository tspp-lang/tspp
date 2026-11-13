const { isTsppConfig } = require("./configuration.js");

/** Synchronize config text without registering TypeScript completion or formatting for JSON documents. */
function registerConfigSync(vscode, context, client, runningState) {
  const opened = new Map();
  let running = false;
  const supported = document => document.uri.scheme === "file" && isTsppConfig(document.fileName)
    && ["json", "jsonc"].includes(document.languageId);
  const send = (method, params, onFailure) => {
    const failed = error => {
      onFailure?.();
      client.error(`Could not synchronize TS++ configuration (${method}).`, error);
    };
    try { void client.sendNotification(method, params).catch(failed); }
    catch (error) { failed(error); }
  };
  const open = document => {
    if (!running || !supported(document)) return;
    const uri = document.uri.toString();
    if (opened.has(uri)) return;
    const token = Symbol(uri);
    opened.set(uri, token);
    send("textDocument/didOpen", { textDocument: {
      uri, languageId: document.languageId, version: document.version, text: document.getText(),
    } }, () => { if (opened.get(uri) === token) opened.delete(uri); });
  };
  context.subscriptions.push(
    client.onDidChangeState(event => {
      const nextRunning = event.newState === runningState;
      if (running === nextRunning) return;
      running = nextRunning;
      opened.clear();
      if (running) vscode.workspace.textDocuments.forEach(open);
    }),
    vscode.workspace.onDidOpenTextDocument(open),
    vscode.workspace.onDidChangeTextDocument(event => {
      const document = event.document;
      if (!running || !supported(document)) return;
      const uri = document.uri.toString();
      if (!opened.has(uri)) { open(document); return; }
      send("textDocument/didChange", {
        textDocument: { uri, version: document.version }, contentChanges: [{ text: document.getText() }],
      });
    }),
    vscode.workspace.onDidCloseTextDocument(document => {
      const uri = document.uri.toString();
      if (opened.delete(uri) && running) send("textDocument/didClose", { textDocument: { uri } });
    }),
    { dispose() { running = false; opened.clear(); } },
  );
}

module.exports = { registerConfigSync };
