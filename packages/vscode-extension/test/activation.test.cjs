const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("ordinary JSON activation defers the server until a TS++ configuration opens", async () => {
  let opened;
  let clients = 0;
  let disposed = 0;
  const disposable = { dispose() {} };
  const vscode = {
    ExtensionMode: { Development: 2 },
    window: { createTextEditorDecorationType: () => disposable },
    commands: { registerCommand: () => disposable },
    workspace: {
      textDocuments: [{ languageId: "json", fileName: "/workspace/package.json", uri: { scheme: "file" } }],
      findFiles: async () => [],
      onDidOpenTextDocument: callback => { opened = callback; return { dispose: () => disposed++ }; },
      getConfiguration: () => ({ get: () => "" }),
      createFileSystemWatcher: () => disposable,
    },
  };
  const stubRequire = name => {
    if (name === "vscode") return vscode;
    if (name === "vscode-languageclient/node") return {
      TransportKind: { stdio: 0 },
      State: { Running: 2 },
      LanguageClient: class {
        constructor() { clients++; }
        start() { return new Promise(() => {}); }
      },
    };
    if (name === "@tspp/plugin-sdk/editor") return { getCodeDecorationSpans() {} };
    if (name === "./configuration.js") return { registerConfigDiagnostics() {}, compilerFile() {} };
    if (name === "./configuration-sync.js") return { registerConfigSync() {} };
    if (name === "./plugin-contributions.json") return {};
    return require(name);
  };
  stubRequire.resolve = () => "/extension/server.js";
  const extension = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8"), {
    require: stubRequire, module: extension, process,
  });
  const context = { subscriptions: [], extensionMode: 2, extensionPath: path.resolve(__dirname, "..") };
  await extension.exports.activate(context);
  assert.equal(clients, 0);
  opened({ languageId: "jsonc", fileName: "/workspace/settings.json", uri: { scheme: "file" } });
  assert.equal(clients, 0);
  opened({ languageId: "jsonc", fileName: "/workspace/tsppconfig.json", uri: { scheme: "file" } });
  assert.equal(clients, 1);
  assert.equal(disposed, 1);
});
