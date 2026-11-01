const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { operatorSectionsPlugin } = require("../dist");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("registers and disposes its expression rewriter", () => {
  let registration;
  let disposed = false;
  const compiler = {
    registerExpressionRewriter(pluginId, rewriter) {
      registration = { pluginId, rewriter };
      return () => { disposed = true; };
    },
  };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts: require("typescript-upstream") });
  host.register(operatorSectionsPlugin);
  host.activateAll();
  assert.equal(registration.pluginId, "operator-sections");
  assert.equal(typeof registration.rewriter.rewrite, "function");
  host.dispose();
  assert.equal(disposed, true);
});
