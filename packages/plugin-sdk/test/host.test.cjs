const assert = require("node:assert/strict");
const { test } = require("node:test");
const { definePlugin, TSPP_PLUGIN_API_VERSION } = require("../dist");
const { TSPPPluginActivationError, TSPPPluginHost } = require("../dist/host");

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const compiler = {
  expressionSyntaxKinds: {},
  registerExpressionSyntax(_pluginId, _syntax) { return () => {}; },
};

function plugin(id, activate = () => {}) {
  return definePlugin({
    manifest: { id, version: "0.0.1", apiVersion: TSPP_PLUGIN_API_VERSION },
    activate,
  });
}

test("definePlugin preserves the plugin object", () => {
  const value = plugin("test/identity");
  assert.equal(definePlugin(value), value);
});

test("the host activates in registration order and disposes in reverse order", () => {
  const events = [];
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(plugin("test/one", context => {
    events.push(`activate:${context.pluginId}`);
    context.onDispose(() => events.push("dispose:one:first"));
    return () => events.push("dispose:one:last");
  }));
  host.register(plugin("test/two", () => {
    events.push("activate:test/two");
    return () => events.push("dispose:two");
  }));

  host.activateAll();
  host.dispose();

  assert.deepEqual(events, [
    "activate:test/one",
    "activate:test/two",
    "dispose:two",
    "dispose:one:last",
    "dispose:one:first",
  ]);
});

test("the host rejects duplicate ids and incompatible APIs", () => {
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(plugin("test/duplicate"));
  assert.throws(() => host.register(plugin("test/duplicate")), /Duplicate TSPP plugin id/);
  assert.throws(() => host.register({
    manifest: { id: "test/future", version: "0.0.1", apiVersion: 2 },
    activate() {},
  }), /requires API 2/);
});

test("activation failure rolls back activated plugins", () => {
  const events = [];
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(plugin("test/ready", () => () => events.push("dispose:ready")));
  host.register(plugin("test/failing", context => {
    context.onDispose(() => events.push("dispose:failing"));
    throw new Error("boom");
  }));

  assert.throws(() => host.activateAll(), TSPPPluginActivationError);
  assert.deepEqual(events, ["dispose:failing", "dispose:ready"]);
});
