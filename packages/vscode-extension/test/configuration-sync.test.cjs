const test = require("node:test");
const assert = require("node:assert/strict");
const { registerConfigSync } = require("../configuration-sync.js");

function fixture() {
  const listeners = {};
  const messages = [];
  const errors = [];
  const documents = [];
  const subscribe = name => callback => { listeners[name] = callback; return { dispose() {} }; };
  const vscode = { workspace: {
    textDocuments: documents,
    onDidOpenTextDocument: subscribe("open"),
    onDidChangeTextDocument: subscribe("change"),
    onDidCloseTextDocument: subscribe("close"),
  } };
  const client = {
    onDidChangeState: subscribe("state"),
    sendNotification: (method, params) => { messages.push({ method, params }); return Promise.resolve(); },
    error: (...args) => errors.push(args),
  };
  const context = { subscriptions: [] };
  registerConfigSync(vscode, context, client, 2);
  function document(name, languageId = "jsonc") {
    const item = { fileName: `/project/${name}`, languageId, version: 1, text: "{}",
      uri: { scheme: "file", toString: () => `file:///project/${name}` }, getText() { return this.text; } };
    documents.push(item);
    return item;
  }
  return { listeners, messages, errors, documents, client, document, context };
}

test("Running sends each current configuration once with its latest startup text", () => {
  const { listeners, messages, document } = fixture();
  const config = document("tsppconfig.json");
  document("package.json", "json");
  listeners.open(config);
  config.text = '{ "compilerOptions": { "strict": true } }';
  config.version = 2;
  listeners.change({ document: config });
  assert.deepEqual(messages, []);
  listeners.state({ newState: 2 });
  assert.deepEqual(messages, [{ method: "textDocument/didOpen", params: { textDocument: {
    uri: config.uri.toString(), languageId: "jsonc", version: 2, text: config.text,
  } } }]);
  listeners.open(config);
  listeners.state({ newState: 2 });
  assert.equal(messages.length, 1);
});

test("changes and closes synchronize configurations without reviving closed tabs on restart", () => {
  const { listeners, messages, document, documents } = fixture();
  const config = document("tsppconfig.demo.json");
  listeners.state({ newState: 2 });
  config.version++;
  config.text = '{ "include": ["demo"] }';
  listeners.change({ document: config });
  assert.deepEqual(messages[1], { method: "textDocument/didChange", params: {
    textDocument: { uri: config.uri.toString(), version: 2 }, contentChanges: [{ text: config.text }],
  } });
  documents.length = 0;
  listeners.close(config);
  assert.deepEqual(messages[2], { method: "textDocument/didClose", params: { textDocument: { uri: config.uri.toString() } } });
  listeners.state({ newState: 1 });
  listeners.state({ newState: 2 });
  assert.equal(messages.length, 3);
});

test("restart reopens surviving configs with edits made while stopped and ignores ordinary JSON", () => {
  const { listeners, messages, document } = fixture();
  const config = document("tsppconfig.json");
  const ordinary = document("tsconfig.json", "json");
  listeners.state({ newState: 2 });
  listeners.open(ordinary);
  listeners.change({ document: ordinary });
  listeners.close(ordinary);
  assert.equal(messages.length, 1);
  listeners.state({ newState: 1 });
  config.text = '{ "files": [] }';
  config.version = 3;
  listeners.change({ document: config });
  assert.equal(messages.length, 1);
  listeners.state({ newState: 2 });
  assert.equal(messages.length, 2);
  assert.equal(messages[1].method, "textDocument/didOpen");
  assert.equal(messages[1].params.textDocument.text, config.text);
  assert.equal(messages[1].params.textDocument.version, 3);
});

test("notification errors are logged and a failed open may be sent again on the next edit", async () => {
  const { listeners, client, errors, document, messages } = fixture();
  const config = document("tsppconfig.json");
  const failure = new Error("connection closed");
  client.sendNotification = () => Promise.reject(failure);
  listeners.state({ newState: 2 });
  await Promise.resolve();
  assert.equal(errors.length, 1);
  assert.equal(errors[0][1], failure);
  client.sendNotification = (method, params) => { messages.push({ method, params }); return Promise.resolve(); };
  listeners.change({ document: config });
  assert.equal(messages[0].method, "textDocument/didOpen");
});

test("a configuration closed during startup is never opened when the server becomes ready", () => {
  const { listeners, messages, document, documents } = fixture();
  const config = document("tsppconfig.json");
  listeners.open(config);
  documents.length = 0;
  listeners.close(config);
  listeners.state({ newState: 2 });
  assert.deepEqual(messages, []);
});
