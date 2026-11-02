const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { macrosPlugin } = require("../dist");

test("registers its source projection and program rebuilder, and removes both on dispose", () => {
  const registered = new Set();
  const register = kind => (pluginId, value) => {
    const key = `${kind}:${pluginId}/${value.id}`;
    registered.add(key);
    return () => registered.delete(key);
  };
  const compiler = {
    expressionSyntaxKinds: {}, typeSyntaxKinds: {},
    registerSourcePreprocessor: register("preprocessor"),
    registerProgramRebuilder: register("rebuilder"),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts: {} });
  host.register(macrosPlugin);
  host.activateAll();
  assert.deepEqual([...registered].sort(), ["preprocessor:macros/macro-syntax", "rebuilder:macros/compile-time-macros"]);
  host.dispose();
  assert.equal(registered.size, 0);
});
