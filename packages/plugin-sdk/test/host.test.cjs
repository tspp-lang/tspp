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
  registerProgramAnalyzer(_pluginId, _analyzer) { return () => {}; },
  registerSourcePreprocessor(_pluginId, _preprocessor) { return () => {}; },
};

function plugin(id, activate = () => {}, manifest = {}) {
  return definePlugin({
    manifest: { id, version: "0.0.1", apiVersion: TSPP_PLUGIN_API_VERSION, ...manifest },
    facets: { compiler: { activate } },
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
    manifest: { id: "test/future", version: "0.0.1", apiVersion: TSPP_PLUGIN_API_VERSION + 1 },
    facets: {},
  }), /requires API \d+; host API is/);
});

test("features discovered after activation can register their compiler facet", () => {
  const events = [];
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.activateAll();
  host.registerAndActivate(plugin("test/dynamic", () => events.push("dynamic")));
  assert.deepEqual(events, ["dynamic"]);
  assert.deepEqual(host.list().map(manifest => manifest.id), ["test/dynamic"]);
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

test("required and optional dependencies determine activation order", () => {
  const events = [];
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(plugin("test/consumer", () => events.push("consumer"), {
    requires: ["test/core"], optionalDependencies: ["test/optional"],
  }));
  host.register(plugin("test/optional", () => events.push("optional")));
  host.register(plugin("test/core", () => events.push("core")));
  host.activateAll();
  assert.deepEqual(events, ["core", "optional", "consumer"]);
});

test("missing, cyclic, and conflicting dependency graphs are rejected", () => {
  const missing = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  missing.register(plugin("test/consumer", undefined, { requires: ["test/missing"] }));
  assert.throws(() => missing.activateAll(), /requires missing plugin/);

  const cyclic = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  cyclic.register(plugin("test/a", undefined, { requires: ["test/b"] }));
  cyclic.register(plugin("test/b", undefined, { requires: ["test/a"] }));
  assert.throws(() => cyclic.activateAll(), /Cyclic TSPP plugin dependency/);

  const conflict = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  conflict.register(plugin("test/a", undefined, { provides: ["test/solver"] }));
  conflict.register(plugin("test/b", undefined, { provides: ["test/solver"] }));
  assert.throws(() => conflict.activateAll(), /both provide 'test\/solver'/);
});

test("plugins reach the APIs of their declared dependencies", () => {
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts: { version: "test" } });
  const seen = [];
  host.register(plugin("test/provider", context => context.provide("test/api", { answer: 42 }), { provides: ["test/api"] }));
  host.register(plugin("test/consumer", context => {
    seen.push(context.ts.version, context.dependencies.get("test/api").answer, context.dependencies.get("test/absent"));
  }, { requires: ["test/provider"] }));
  host.activateAll();
  assert.deepEqual(seen, ["test", 42, undefined]);
});

test("an optional provider registered later is visible to a dependent that reads it lazily", () => {
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.activateAll();
  let read;
  host.registerAndActivate(plugin("test/consumer", context => { read = () => context.dependencies.get("test/api"); }, {
    optionalDependencies: ["test/provider"],
  }));
  assert.equal(read(), undefined);
  host.registerAndActivate(plugin("test/provider", context => context.provide("test/api", "late"), { provides: ["test/api"] }));
  assert.equal(read(), "late");
});

test("plugins cannot provide undeclared APIs or use undeclared dependencies", () => {
  const undeclaredProvide = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  undeclaredProvide.register(plugin("test/provider", context => context.provide("test/api", {})));
  assert.throws(() => undeclaredProvide.activateAll(), /must declare 'test\/api' in provides/);

  const undeclaredUse = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  undeclaredUse.register(plugin("test/provider", context => context.provide("test/api", {}), { provides: ["test/api"] }));
  undeclaredUse.register(plugin("test/consumer", context => context.dependencies.get("test/api")));
  assert.throws(() => undeclaredUse.activateAll(), /without declaring the dependency/);
});

test("late plugins can require already active capsules", () => {
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler });
  host.register(plugin("test/core"));
  host.activateAll();
  host.registerAndActivate(plugin("test/consumer", undefined, { requires: ["test/core"] }));
  assert.throws(
    () => host.registerAndActivate(plugin("test/broken", undefined, { requires: ["test/missing"] })),
    /requires missing plugin/,
  );
});

test("language-service facets register feature-owned semantic providers", () => {
  const providers = [];
  const languageService = {
    registerQuickInfoProvider(pluginId, provider) {
      const entry = { pluginId, provider };
      providers.push(entry);
      return () => providers.splice(providers.indexOf(entry), 1);
    },
  };
  const feature = definePlugin({
    manifest: { id: "test/tooling", version: "0.0.1", apiVersion: TSPP_PLUGIN_API_VERSION },
    facets: {
      languageService: {
        activate(context) {
          context.onDispose(context.languageService.registerQuickInfoProvider(() => ({
            start: 0, length: 4, display: "tooling", documentation: "owned by feature",
          })));
        },
      },
    },
  });
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, languageService });
  host.register(feature).activateAll();
  assert.equal(providers[0].pluginId, "test/tooling");
  assert.equal(providers[0].provider({ fileName: "x.tspp", sourceText: "test", position: 1 }).display, "tooling");
  host.dispose();
  assert.equal(providers.length, 0);
});
