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
  assert.equal(registration.syntax.runtime, "erased");
  assert.equal(registration.syntax.valueUse, "call-only");

  const declaration = {};
  const notEmitted = {};
  assert.equal(registration.syntax.transform(declaration, {
    createNotEmittedStatement(node) {
      assert.equal(node, declaration);
      return notEmitted;
    },
  }), notEmitted);

  const argument = {};
  const visitedArgument = {};
  assert.equal(registration.syntax.transformCall({}, declaration, {
    getArguments() { return [argument]; },
    visitExpression(node) {
      assert.equal(node, argument);
      return visitedArgument;
    },
  }), visitedArgument);
  const invalidCall = {};
  assert.equal(registration.syntax.transformCall(invalidCall, declaration, {
    getArguments() { return []; },
    visitExpression() { throw new Error("invalid calls must not be erased"); },
  }), invalidCall);

  let emitted;
  registration.syntax.emitDeclaration(declaration, {
    emitTypeAliasDeclaration(node, keyword) {
      emitted = { node, keyword };
    },
  });
  assert.deepEqual(emitted, { node: declaration, keyword: "newtype" });

  host.dispose();
  assert.equal(disposed, true);
});
