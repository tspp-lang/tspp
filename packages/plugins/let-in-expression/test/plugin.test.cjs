const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { letInExpressionPlugin } = require("../dist");

const expressionSyntaxKinds = {
  endOfFileToken: 0,
  identifier: 1,
  openBracketToken: 2,
  closeBracketToken: 3,
  openBraceToken: 4,
  closeBraceToken: 5,
  openParenToken: 6,
  closeParenToken: 7,
  semicolonToken: 8,
  inKeyword: 9,
  letKeyword: 10,
};

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("registers one let-started expression capsule and disposes it", () => {
  let registration;
  let disposed = false;
  const compiler = {
    expressionSyntaxKinds,
    registerExpressionSyntax(pluginId, syntax) {
      registration = { pluginId, syntax };
      return () => { disposed = true; };
    },
  };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(letInExpressionPlugin);
  host.activateAll();

  assert.equal(registration.pluginId, "modern-syntax/let-in");
  assert.deepEqual(registration.syntax.startTokens, [expressionSyntaxKinds.letKeyword]);

  host.dispose();
  assert.equal(disposed, true);
});
