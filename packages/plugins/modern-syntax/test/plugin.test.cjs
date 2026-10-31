const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { modernSyntaxPlugin } = require("../dist");

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
  equalsToken: 9,
  colonToken: 10,
  lessThanToken: 11,
  minusToken: 12,
  inKeyword: 13,
  letKeyword: 14,
  doKeyword: 15,
  whileKeyword: 16,
};

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

test("registers modern expressions and completion-valued function bodies", () => {
  let expressionRegistration;
  let bodyRegistration;
  let trailingClosureRegistration;
  let deepReadonlyRegistration;
  let disposed = false;
  const compiler = {
    expressionSyntaxKinds,
    registerExpressionSyntax(pluginId, syntax) {
      expressionRegistration = { pluginId, syntax };
      return () => { disposed = true; };
    },
    registerFunctionBodySyntax(pluginId, syntax) {
      bodyRegistration = { pluginId, syntax };
      return () => { disposed = true; };
    },
    registerTrailingClosureBindingSyntax(pluginId, syntax) {
      trailingClosureRegistration = { pluginId, syntax };
      return () => { disposed = true; };
    },
    registerDeepReadonlyBindingSyntax(pluginId, syntax) {
      deepReadonlyRegistration = { pluginId, syntax };
      return () => { disposed = true; };
    },
  };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(modernSyntaxPlugin);
  host.activateAll();

  assert.equal(expressionRegistration.pluginId, "modern-syntax");
  assert.deepEqual(expressionRegistration.syntax.startTokens, [
    expressionSyntaxKinds.letKeyword,
    expressionSyntaxKinds.doKeyword,
  ]);
  assert.equal(bodyRegistration.pluginId, "modern-syntax");
  assert.deepEqual(bodyRegistration.syntax.startTokens, [expressionSyntaxKinds.doKeyword]);
  assert.equal(bodyRegistration.syntax.completion, "implicit-return");
  assert.equal(trailingClosureRegistration.pluginId, "modern-syntax");
  assert.deepEqual(trailingClosureRegistration.syntax.startTokens, [expressionSyntaxKinds.identifier]);
  assert.equal(deepReadonlyRegistration.pluginId, "modern-syntax");
  assert.deepEqual(deepReadonlyRegistration.syntax.startTokens, [expressionSyntaxKinds.identifier]);

  host.dispose();
  assert.equal(disposed, true);
});
