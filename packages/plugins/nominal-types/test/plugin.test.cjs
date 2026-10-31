const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { nominalTypesPlugin } = require("../dist");

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test("registers a type-and-value declaration capsule", () => {
  const registrations = [];
  const expressions = [];
  let disposed = 0;
  const compiler = {
    expressionSyntaxKinds: { identifier: 1 },
    declarationSyntaxKinds: {
      identifier: 1,
      equalsToken: 2,
      barToken: 3,
      openParenToken: 4,
      closeParenToken: 5,
      commaToken: 6,
      colonToken: 7,
    },
    registerDeclarationSyntax(pluginId, syntax) {
      registrations.push({ pluginId, syntax });
      return () => { disposed++; };
    },
    registerExpressionSyntax(pluginId, syntax) {
      expressions.push({ pluginId, syntax });
      return () => { disposed++; };
    },
  };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(nominalTypesPlugin);
  host.activateAll();
  const newtype = registrations.find(registration => registration.syntax.binding === "type-and-value");
  const data = registrations.find(registration => registration.syntax.binding === "type");
  assert.equal(newtype.pluginId, "nominal-types");
  assert.equal(newtype.syntax.runtime, "erased");
  assert.equal(newtype.syntax.valueUse, "call-only");
  assert.equal(data.pluginId, "nominal-types");
  assert.equal(data.syntax.runtime, "emitted");
  const match = expressions[0];
  assert.equal(match.pluginId, "nominal-types");

  const checkedType = {};
  const matchNode = {};
  assert.equal(match.syntax.check(matchNode, {
    checkTaggedUnionMatch(node, mode) {
      assert.equal(node, matchNode);
      assert.equal(mode, 7);
      return checkedType;
    },
  }, 7), checkedType);

  const declaration = {};
  const notEmitted = {};
  assert.equal(newtype.syntax.transform(declaration, {
    createNotEmittedStatement(node) {
      assert.equal(node, declaration);
      return notEmitted;
    },
  }), notEmitted);

  const argument = {};
  const visitedArgument = {};
  assert.equal(newtype.syntax.transformCall({}, declaration, {
    getArguments() { return [argument]; },
    visitExpression(node) {
      assert.equal(node, argument);
      return visitedArgument;
    },
  }), visitedArgument);
  const invalidCall = {};
  assert.equal(newtype.syntax.transformCall(invalidCall, declaration, {
    getArguments() { return []; },
    visitExpression() { throw new Error("invalid calls must not be erased"); },
  }), invalidCall);

  let emitted;
  newtype.syntax.emitDeclaration(declaration, {
    emitTypeAliasDeclaration(node, keyword) {
      emitted = { node, keyword };
    },
  });
  assert.deepEqual(emitted, { node: declaration, keyword: "newtype" });

  const generated = [{ statement: true }];
  assert.equal(data.syntax.transform(declaration, {
    createTaggedUnionStatements(node) {
      assert.equal(node, declaration);
      return generated;
    },
  }), generated);
  data.syntax.emitDeclaration(declaration, {
    emitTaggedUnionDeclaration(node, keyword) {
      emitted = { node, keyword };
    },
  });
  assert.deepEqual(emitted, { node: declaration, keyword: "data" });

  assert.throws(
    () => match.syntax.transform(),
    /lowered to standard TypeScript/,
  );

  host.dispose();
  assert.equal(disposed, 3);
});
