const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { macrosPlugin } = require("../dist");

test("registers the compile-time macro capability", () => {
  let owner;
  const compiler = {
    expressionSyntaxKinds: {}, declarationSyntaxKinds: {}, typeSyntaxKinds: {},
    registerCompileTimeMacros(pluginId) {
      owner = pluginId;
      return () => { owner = undefined; };
    },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(macrosPlugin);
  host.activateAll();
  assert.equal(owner, "macros");
  host.dispose();
  assert.equal(owner, undefined);
});
