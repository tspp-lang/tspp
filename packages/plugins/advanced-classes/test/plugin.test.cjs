const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { ts } = require("../../test-support/compile.cjs");
const { advancedClassesPlugin } = require("../dist");

test("registers its syntax extensions and diagnostics, and removes them on dispose", () => {
  const registered = new Set();
  const register = kind => (_pluginId, value) => {
    const key = `${kind}:${value.position ?? value.id}`;
    registered.add(key);
    return () => registered.delete(key);
  };
  const compiler = {
    registerSyntaxExtension: register("syntax"),
    registerDiagnosticProvider: register("diagnostics"),
    registerSourcePreprocessor: register("preprocessor"),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts });
  host.register(advancedClassesPlugin);
  host.activateAll();

  assert(registered.has("syntax:declaration"));
  assert(registered.has("syntax:primary-expression"));
  assert(registered.has("syntax:expression"));
  assert(registered.has("diagnostics:advanced-classes-diagnostics"));

  host.dispose();
  assert.equal(registered.size, 0);
});

