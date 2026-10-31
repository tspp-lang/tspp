const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { staticInterfaceMembersPlugin } = require("../dist");

test("registers a class-static interface contract", () => {
  let registration;
  let disposed = false;
  const compiler = {
    expressionSyntaxKinds: {}, declarationSyntaxKinds: {}, typeSyntaxKinds: {},
    registerInterfaceMemberContract(pluginId, contract) {
      registration = { pluginId, contract };
      return () => { disposed = true; };
    },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(staticInterfaceMembersPlugin);
  host.activateAll();

  assert.deepEqual(registration, {
    pluginId: "static-interface-members",
    contract: {
      modifier: "static",
      implementationSide: "class-static",
      thisType: "implementing-instance",
    },
  });
  host.dispose();
  assert.equal(disposed, true);
});
