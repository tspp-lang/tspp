const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { newtypePlugin } = require("../dist");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("registers a type-and-value declaration capsule", () => {
  let registration;
  let disposed = false;
  const compiler = {
    expressionSyntaxKinds: {},
    declarationSyntaxKinds: { identifier: 1, equalsToken: 2 },
    registerDeclarationSyntax(pluginId, syntax) {
      registration = { pluginId, syntax };
      return () => { disposed = true; };
    },
  };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(newtypePlugin);
  host.activateAll();
  assert.equal(registration.pluginId, "nominal-types/newtype");
  assert.equal(registration.syntax.binding, "type-and-value");
  host.dispose();
  assert.equal(disposed, true);
});
