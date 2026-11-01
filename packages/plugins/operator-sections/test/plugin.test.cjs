const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { operatorSectionsPlugin } = require("../dist");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("registers and disposes placeholder expression syntax", () => {
  let registration;
  let disposed = false;
  const compiler = {
    registerPlaceholderExpressionSyntax(pluginId, syntax) {
      registration = { pluginId, syntax };
      return () => { disposed = true; };
    },
  };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(operatorSectionsPlugin);
  host.activateAll();
  assert.deepEqual(registration, {
    pluginId: "operator-sections",
    syntax: { placeholder: "_" },
  });
  host.dispose();
  assert.equal(disposed, true);
});
