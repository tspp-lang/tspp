const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { typeComputationPlugin } = require("../dist");

test("registers type-position syntax as one capsule", () => {
  const typeSyntaxKinds = {
    endOfFileToken: 0, identifier: 1, letKeyword: 2, inKeyword: 3, inferKeyword: 4,
    lessThanToken: 5, greaterThanToken: 6, equalsToken: 7, equalsGreaterThanToken: 8,
    openBraceToken: 9, closeBraceToken: 10, colonToken: 11, commaToken: 12, semicolonToken: 13,
  };
  let registration;
  const compiler = {
    expressionSyntaxKinds: {}, declarationSyntaxKinds: {}, typeSyntaxKinds,
    registerTypeSyntax(pluginId, syntax) {
      registration = { pluginId, syntax };
      return () => {};
    },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(typeComputationPlugin);
  host.activateAll();
  assert.equal(registration.pluginId, "type-computation");
  assert.deepEqual(registration.syntax.startTokens, [2, 1, 5]);
  assert.equal(registration.syntax.preserveDeclarationText, true);
});
