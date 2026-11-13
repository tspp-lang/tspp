const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configDiagnostics, registerConfigDiagnostics, compilerFile, isTsppConfig } = require("../configuration.js");
const ts = require("../../compiler/built/local/typescript.js");

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-config-editor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function configuration(options = {}) {
  return JSON.stringify({ compilerOptions: { target: "es2022", ...options }, include: ["*.tspp"] });
}

test("configuration diagnostics come from compiler parsing and accept TS++ inputs", t => {
  const root = workspace(t);
  const config = path.join(root, "tsppconfig.json");
  fs.writeFileSync(path.join(root, "main.tspp"), "export const value = 1;\n");
  assert.deepEqual(configDiagnostics(ts, config, configuration()), []);
  assert.ok(configDiagnostics(ts, config, configuration({ strcit: true })).some(error => error.code === 5025 || error.code === 5023));
  assert.ok(configDiagnostics(ts, config, configuration({ strict: "yes" })).some(error => error.code === 5024));
  assert.ok(configDiagnostics(ts, config, '{ "compilerOptions": { "target": ').length > 0);
  assert.ok(configDiagnostics(ts, config, '{ "extends": "./missing.json" }').some(error => error.code === 5083));
  const missingFiles = configDiagnostics(ts, config, '{ "files": ["./first.tspp", "./second.tspp"] }');
  const missingMessages = missingFiles.map(problem => ts.flattenDiagnosticMessageText(problem.messageText, "\n"));
  assert.ok(missingMessages.some(message => message.includes("first.tspp")));
  assert.ok(missingMessages.some(message => message.includes("second.tspp")));
});

test("unsupported SDKs fail clearly and show a configuration diagnostic instead of ordinary TS fallback", () => {
  const oldSdk = require("typescript");
  assert.throws(() => configDiagnostics(oldSdk, "/project/tsppconfig.json", "{}"), /Rebuild or update the TS\+\+ SDK/);
  const editor = mockEditor([]);
  const document = { fileName: "/project/tsppconfig.json", uri: editor.uri("/project/tsppconfig.json"), getText: () => "{}" };
  editor.vscode.workspace.textDocuments.push(document);
  registerConfigDiagnostics(editor.vscode, { subscriptions: [] }, () => oldSdk);
  const problems = [...editor.diagnostics.values()].flat();
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /Rebuild or update the TS\+\+ SDK/);
  assert.equal(problems[0].severity, editor.vscode.DiagnosticSeverity.Error);
});

test("config diagnostics read unsaved inherited JSON and report no-input configurations", t => {
  const root = workspace(t);
  const config = path.join(root, "tsppconfig.json");
  const base = path.join(root, "base.json");
  fs.writeFileSync(base, configuration());
  assert.ok(configDiagnostics(ts, config, '{ "extends": "./base.json" }').some(error => error.code === 18003));
  fs.writeFileSync(path.join(root, "main.tspp"), "export {};\n");
  const problems = configDiagnostics(ts, config, '{ "extends": "./base.json" }',
    new Map([[base, configuration({ strict: "invalid" })]]));
  assert.ok(problems.some(error => error.code === 5024));
  assert.ok(problems.some(error => error.file?.fileName.replaceAll("\\", "/").endsWith("/base.json")));
});

test("configuration diagnostics preserve TS++ identity through custom JSON references", t => {
  const root = workspace(t);
  const config = path.join(root, "tsppconfig.json");
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "base"));
  fs.writeFileSync(path.join(root, "src/main.tspp"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "base/tsppconfig.json"), JSON.stringify({ compilerOptions: { target: "es2022", composite: true } }));
  fs.writeFileSync(path.join(root, "app.json"), JSON.stringify({ extends: "./base", include: ["src/**/*.tspp"] }));
  const text = JSON.stringify({ compilerOptions: { target: "es2022" }, files: [], references: [{ path: "./app.json" }] });
  const problems = configDiagnostics(ts, config, text);
  assert.deepEqual(problems.map(problem => [problem.code, ts.flattenDiagnosticMessageText(problem.messageText, "\n")]), []);
});

function mockEditor(documents) {
  const listeners = {};
  const diagnostics = new Map();
  const disposable = { dispose() {} };
  const subscribe = name => callback => { listeners[name] = callback; return disposable; };
  const uri = file => ({ fsPath: file, scheme: "file", toString: () => `file://${file}` });
  const vscode = {
    Uri: { file: uri },
    Range: class { constructor(...values) { this.values = values; } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Warning: 1, Error: 0 },
    languages: { createDiagnosticCollection: () => ({
      clear: () => diagnostics.clear(),
      set: (resource, entries) => diagnostics.set(resource.toString(), entries),
      dispose() {},
    }) },
    workspace: {
      textDocuments: documents,
      createFileSystemWatcher: pattern => {
        listeners.pattern = pattern;
        return { onDidCreate: subscribe("create"), onDidChange: subscribe("change"), onDidDelete: subscribe("delete"), dispose() {} };
      },
      onDidOpenTextDocument: subscribe("open"),
      onDidChangeTextDocument: subscribe("edit"),
      onDidCloseTextDocument: subscribe("close"),
    },
  };
  return { vscode, diagnostics, listeners, uri };
}

test("opening only a config validates unsaved edits and creation/deletion refreshes no-input errors", async t => {
  const root = workspace(t);
  const editor = mockEditor([]);
  const config = path.join(root, "tsppconfig.json");
  let text = configuration();
  const document = { fileName: config, uri: editor.uri(config), getText: () => text };
  editor.vscode.workspace.textDocuments.push(document);
  registerConfigDiagnostics(editor.vscode, { subscriptions: [] }, () => ts);
  const current = () => [...editor.diagnostics.values()].flat();
  assert.ok(current().some(problem => problem.code === 18003));
  const source = path.join(root, "main.tspp");
  fs.writeFileSync(source, "export {};\n");
  editor.listeners.create(editor.uri(source));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(current(), []);
  text = configuration({ strict: "invalid" });
  editor.listeners.edit({ document });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(current().some(problem => problem.code === 5024));
  text = configuration();
  editor.listeners.edit({ document });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(current(), []);
  fs.unlinkSync(source);
  editor.listeners.delete(editor.uri(source));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(current().some(problem => problem.code === 18003));
  editor.vscode.workspace.textDocuments.length = 0;
  editor.listeners.close(document);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.deepEqual(current(), []);
});

test("configuration identity and generated schema preserve JSONC and compiler option hints", () => {
  assert.equal(isTsppConfig("/project/tsppconfig.json"), true);
  assert.equal(isTsppConfig("/project/tsppconfig.demo.json"), true);
  assert.equal(isTsppConfig("/project/tsconfig.json"), false);
  const manifest = require("../package.json");
  assert.ok(manifest.activationEvents.includes("onLanguage:jsonc"));
  assert.ok(manifest.contributes.languages.find(language => language.id === "jsonc").filenames.includes("tsppconfig.json"));
  const schema = require("../schemas/tsppconfig.schema.json");
  const options = schema.properties.compilerOptions.properties;
  for (const declaration of ts.optionDeclarations.filter(option => !option.isCommandLineOnly)) {
    assert.ok(Object.hasOwn(options, declaration.name), declaration.name);
  }
  assert.deepEqual(options.strict.type, ["boolean", "null"]);
  assert.deepEqual(options.target.type, ["string", "null"]);
  assert.deepEqual(options.types.type, ["array", "null"]);
  assert.ok(options.target.anyOf.some(branch => branch.type === "null"));
  assert.ok(options.target.anyOf[0].enum.includes("es2022"));
  const acceptsEnum = (option, value) => option.anyOf[0].enum.includes(value) || new RegExp(option.anyOf[1].pattern).test(value);
  for (const [name, value] of Object.entries({ target: "ES2022", module: "Node16", moduleResolution: "NodeNext" })) {
    assert.equal(acceptsEnum(options[name], value), true, `${name}=${value}`);
    assert.equal(acceptsEnum(options[name], "invalid-option-value"), false, name);
  }
  const lib = options.lib.items;
  assert.equal(acceptsEnum(lib, "ES2015.Promise"), true);
  assert.equal(acceptsEnum(lib, "es2015Xpromise"), false);
  assert.equal(lib.type, "string");
  const sample = require("../../examples/14-typescript-interop/tsppconfig.json").compilerOptions;
  for (const name of ["target", "module", "moduleResolution"]) {
    assert.equal(acceptsEnum(options[name], sample[name]), true, `existing example ${name}=${sample[name]}`);
  }
  const resetConfig = ts.parseJsonConfigFileContent({ files: [], compilerOptions: { strict: null, target: null, types: null } }, ts.sys, process.cwd());
  assert.equal(resetConfig.errors.some(problem => problem.code === 5024), false);
  assert.equal(options.plugins.items.properties.tspp.type, "boolean");
  assert.equal(options.paths.additionalProperties.items.type, "string");
  const developmentServer = path.resolve(__dirname, "../../compiler/built/local/tsserver.js");
  assert.equal(compilerFile(developmentServer), path.join(path.dirname(developmentServer), "typescript.js"));
});

test("file-event bursts are merged and ordinary JSON documents never load the compiler", async t => {
  const root = workspace(t);
  const editor = mockEditor([]);
  let compilerLoads = 0;
  const context = { subscriptions: [] };
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  registerConfigDiagnostics(editor.vscode, context, () => { compilerLoads++; return ts; });
  assert.equal(compilerLoads, 0);
  const config = path.join(root, "tsppconfig.json");
  const document = { fileName: config, uri: editor.uri(config), getText: () => configuration() };
  editor.vscode.workspace.textDocuments.push(document);
  editor.listeners.open(document);
  for (let index = 0; index < 10; index++) {
    const file = path.join(root, `source${index}.tspp`);
    fs.writeFileSync(file, "export {};\n");
    editor.listeners.create(editor.uri(file));
  }
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(compilerLoads, 1);
  assert.deepEqual([...editor.diagnostics.values()].flat(), []);
});

test("saving an inherited configuration updates diagnostics in the open project config", async t => {
  const root = workspace(t);
  const editor = mockEditor([]);
  const config = path.join(root, "tsppconfig.json");
  const base = path.join(root, "base.json");
  fs.writeFileSync(base, configuration());
  fs.writeFileSync(path.join(root, "main.tspp"), "export {};\n");
  editor.vscode.workspace.textDocuments.push({ fileName: config, uri: editor.uri(config), getText: () => '{ "extends": "./base.json" }' });
  const context = { subscriptions: [] };
  t.after(() => context.subscriptions.forEach(item => item.dispose()));
  registerConfigDiagnostics(editor.vscode, context, () => ts);
  assert.deepEqual([...editor.diagnostics.values()].flat(), []);
  fs.writeFileSync(base, configuration({ strict: "invalid" }));
  editor.listeners.change(editor.uri(base));
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok([...editor.diagnostics.values()].flat().some(problem => problem.code === 5024));
});
