const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { staticInterfaceMembersPlugin } = require("../dist");

test("registers a static interface member contract, its static-side check, and its declaration output", () => {
  const registrations = [];
  let disposed = 0;
  const register = kind => (pluginId, value) => {
    registrations.push({ kind, pluginId, value });
    return () => { disposed++; };
  };
  const compiler = {
    registerInterfaceMemberContract: register("contract"),
    registerDiagnosticProvider: register("diagnostics"),
    registerSyntaxExtension: register("syntax"),
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts: require("typescript-upstream") });
  host.register(staticInterfaceMembersPlugin);
  host.activateAll();

  assert.deepEqual(registrations.map(({ kind, pluginId }) => [kind, pluginId]), [
    ["contract", "static-interface-members"],
    ["diagnostics", "static-interface-members"],
    ["syntax", "static-interface-members"],
  ]);
  assert.deepEqual(registrations[0].value, { modifier: "static" });
  assert.equal(typeof registrations[1].value.getSemanticDiagnostics, "function");
  assert.deepEqual(registrations[2].value.startTokens, []);
  host.dispose();
  assert.equal(disposed, 3);
});
