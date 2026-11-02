const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { ts } = require("../../test-support/compile.cjs");
const { modernSyntaxPlugin } = require("../dist");

test("registers its syntax extensions and diagnostics, and removes them on dispose", () => {
  const registered = new Set();
  const register = kind => (_pluginId, value) => {
    const key = `${kind}:${value.position ?? value.id}`;
    registered.add(key);
    return () => registered.delete(key);
  };
  const compiler = {
    expressionSyntaxKinds: {}, declarationSyntaxKinds: {}, typeSyntaxKinds: {},
    registerSyntaxExtension: register("syntax"),
    registerDiagnosticProvider: register("diagnostics"),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts });
  host.register(modernSyntaxPlugin);
  host.activateAll();
  assert.deepEqual([...registered].sort(), ["diagnostics:misplaced-use", "syntax:expression", "syntax:function-body", "syntax:statement"]);
  host.dispose();
  assert.equal(registered.size, 0);
});
