const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { ts } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin } = require("../dist");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("registers its declaration and match syntax and its diagnostics, and removes them on dispose", () => {
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
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts });
  host.register(nominalTypesPlugin);
  host.activateAll();
  assert.deepEqual([...registered].sort(), ["diagnostics:nominal-types", "syntax:declaration", "syntax:expression"]);
  host.dispose();
  assert.equal(registered.size, 0);
});
