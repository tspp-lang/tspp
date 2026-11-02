const assert = require("node:assert/strict");
const { test } = require("node:test");
const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
const { ts } = require("../../test-support/compile.cjs");
const { typeComputationPlugin } = require("../dist");
const { parseKind } = require("../dist/kinds");

function activate() {
  const syntax = [];
  const typeExtensions = [];
  const diagnosticProviders = [];
  const compiler = new Proxy({
    registerSyntaxExtension(pluginId, extension) { syntax.push({ pluginId, extension }); return () => {}; },
    registerTypeExtension(pluginId, extension) { typeExtensions.push({ pluginId, extension }); return () => {}; },
    registerDiagnosticProvider(pluginId, provider) { diagnosticProviders.push({ pluginId, provider }); return () => {}; },
  }, { get: (target, name) => target[name] ?? (() => () => {}) });
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, ts, compiler });
  host.register(typeComputationPlugin);
  host.activateAll();
  return { syntax, typeExtensions, diagnosticProviders };
}

test("registers type-position syntax, a type extension, and declaration restorers as one capsule", () => {
  const { syntax, typeExtensions, diagnosticProviders } = activate();
  assert.deepEqual(syntax.map(entry => entry.extension.position), ["expression", "expression", "type", "postfix-type", "type-parameter-annotation", "type-alias-annotation"]);
  assert.ok(syntax.every(entry => entry.pluginId === "type-computation"));
  const typeSyntax = syntax[2].extension;
  assert.deepEqual(typeSyntax.startTokens, [ts.SyntaxKind.LetKeyword, ts.SyntaxKind.Identifier, ts.SyntaxKind.LessThanToken, ts.SyntaxKind.OpenParenToken, ts.SyntaxKind.OpenBraceToken]);
  assert.equal(typeof typeSyntax.restoreDeclaration, "function");
  assert.equal(typeof typeSyntax.restoreCompatibilityDeclaration, "function");
  assert.equal(typeExtensions.length, 1);
  assert.equal(diagnosticProviders.length, 2);
});

test("parses unary and multi-parameter function kinds", () => {
  const kinds = ts.SyntaxKind;
  function parse(tokens) {
    let index = 0;
    const cursor = {
      token: () => tokens[index]?.kind ?? kinds.EndOfFileToken,
      tokenText: () => tokens[index]?.text ?? "",
      nextToken: () => (index++, cursor.token()),
      parseExpected(kind) {
        assert.equal(cursor.token(), kind);
        cursor.nextToken();
        return true;
      },
    };
    return parseKind(ts, cursor);
  }
  const type = text => ({ kind: kinds.Identifier, text });
  const arrow = { kind: kinds.EqualsGreaterThanToken, text: "=>" };

  assert.deepEqual(parse([type("Type"), arrow, type("Type1")]), {
    kind: "function",
    parameters: [{ kind: "type", level: 0 }],
    result: { kind: "type", level: 1 },
  });
  assert.equal(parse([
    { kind: kinds.OpenParenToken, text: "(" }, type("Type"), { kind: kinds.CommaToken, text: "," },
    type("Type"), { kind: kinds.CloseParenToken, text: ")" }, arrow, type("Type"),
  ]).parameters.length, 2);
  assert.deepEqual(parse([type("Type12")]), { kind: "type", level: 12 });
  assert.throws(() => parse([type("number")]), /Expected a type kind/);
});
