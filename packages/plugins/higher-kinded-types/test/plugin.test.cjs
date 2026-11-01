const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { higherKindedTypesPlugin } = require("../dist");

test("registers kind annotations as an isolated syntax facet", () => {
  const typeSyntaxKinds = { colonToken: 1 };
  let registration;
  const compiler = {
    expressionSyntaxKinds: {}, declarationSyntaxKinds: {}, typeSyntaxKinds,
    registerKindAnnotationSyntax(pluginId, syntax) {
      registration = { pluginId, syntax };
      return () => {};
    },
    registerTypeSyntax() { return () => {}; },
    registerPostfixTypeSyntax() { return () => {}; },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(higherKindedTypesPlugin);
  host.activateAll();
  assert.equal(registration.pluginId, "higher-kinded-types");
  assert.deepEqual(registration.syntax.startTokens, [1]);
});

test("parses unary and multi-parameter function kinds", () => {
  const kinds = {
    colonToken: 1, identifier: 2, openParenToken: 3, closeParenToken: 4,
    commaToken: 5, equalsGreaterThanToken: 6, endOfFileToken: 7, lessThanToken: 8,
  };
  let syntax;
  let universeSyntax;
  let applicationSyntax;
  const compiler = {
    expressionSyntaxKinds: {}, declarationSyntaxKinds: {}, typeSyntaxKinds: kinds,
    registerKindAnnotationSyntax(_pluginId, value) { syntax = value; return () => {}; },
    registerTypeSyntax(_pluginId, value) { universeSyntax = value; return () => {}; },
    registerPostfixTypeSyntax(_pluginId, value) { applicationSyntax = value; return () => {}; },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(higherKindedTypesPlugin);
  host.activateAll();

  function parse(tokens) {
    let index = 0;
    const parser = {
      kinds,
      token: () => tokens[index]?.kind ?? kinds.endOfFileToken,
      tokenText: () => tokens[index]?.text ?? "",
      nextToken: () => (index++, parser.token()),
      parseExpected(kind) {
        assert.equal(parser.token(), kind);
        parser.nextToken();
        return true;
      },
    };
    return syntax.parse(parser);
  }

  assert.deepEqual(parse([
    { kind: 1, text: ":" }, { kind: 2, text: "Type" },
    { kind: 6, text: "=>" }, { kind: 2, text: "Type1" },
  ]), {
    kind: "function",
    parameters: [{ kind: "type", level: 0 }],
    result: { kind: "type", level: 1 },
  });
  assert.deepEqual(parse([
    { kind: 1, text: ":" }, { kind: 3, text: "(" },
    { kind: 2, text: "Type" }, { kind: 5, text: "," },
    { kind: 2, text: "Type" }, { kind: 4, text: ")" },
    { kind: 6, text: "=>" }, { kind: 2, text: "Type" },
  ]).parameters.length, 2);

  let finished;
  const universeParser = {
    kinds,
    token: () => kinds.identifier,
    tokenText: () => "Type12",
    getNodePos: () => 41,
    nextToken: () => kinds.endOfFileToken,
    finishTypeUniverse(level, pos) { finished = { level, pos }; return finished; },
  };
  assert.equal(universeSyntax.isStart(universeParser), true);
  assert.equal(universeSyntax.preserveDeclarationText, true);
  assert.deepEqual(universeSyntax.parse(universeParser), { level: 12, pos: 41 });

  const target = { target: true };
  const argumentsList = [{ argument: true }];
  const applicationParser = {
    kinds,
    token: () => kinds.lessThanToken,
    getNodePos: () => 52,
    parseTypeArguments: () => argumentsList,
    finishTypeApplication(value, typeArguments, pos) { return { value, typeArguments, pos }; },
  };
  assert.equal(applicationSyntax.isStart(applicationParser), true);
  assert.deepEqual(applicationSyntax.parse(target, applicationParser), {
    value: target, typeArguments: argumentsList, pos: 52,
  });
});
