const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { operatorSectionsPlugin } = require("../dist");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("registers and disposes its syntax for parenthesized expressions and call arguments", () => {
  const registrations = [];
  let disposed = 0;
  const compiler = {
    registerSyntaxExtension(pluginId, extension) {
      registrations.push({ pluginId, extension });
      return () => { disposed++; };
    },
    registerDiagnosticProvider() {
      return () => { disposed++; };
    },
  };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts: require("typescript-upstream") });
  host.register(operatorSectionsPlugin);
  host.activateAll();
  assert.deepEqual(registrations.map(({ pluginId, extension }) => [pluginId, extension.position]), [
    ["operator-sections", "primary-expression"],
    ["operator-sections", "argument"],
  ]);
  host.dispose();
  assert.equal(disposed, 3);
});
