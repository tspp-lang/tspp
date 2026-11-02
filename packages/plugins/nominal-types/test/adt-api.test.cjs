// The `nominal-types/adt` API that dependents such as formal-verification use instead of reading `data` themselves.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { nominalTypesADTAPI } = require("../dist");

test("describes data declarations, their fields, and their run-time tags", () => {
  const [list, option] = nominalTypesADTAPI.getDataTypes(`
    data BigIntList = End | Link(head: bigint, tail: BigIntList);
    const unrelated = 1;
    data Option<T, E = never> = None | Some(value: Map<string, T>, pair: [T, E]);
  `);
  assert.deepEqual(list, {
    name: "BigIntList",
    typeParameters: [],
    variants: [
      { name: "End", fields: [] },
      { name: "Link", fields: [{ name: "head", type: "bigint" }, { name: "tail", type: "BigIntList" }] },
    ],
  });
  assert.deepEqual(option.typeParameters, ["T", "E"]);
  assert.deepEqual(option.variants[1].fields, [{ name: "value", type: "Map<string, T>" }, { name: "pair", type: "[T, E]" }]);
  assert.equal(nominalTypesADTAPI.tagProperty, "_tag");
  assert.equal(nominalTypesADTAPI.tagOf(list.variants[1]), "Link");
});

test("is provided to plugins that depend on nominal-types", () => {
  const { TSPPPluginHost } = require("@tspp/plugin-sdk/host");
  const { nominalTypesPlugin } = require("../dist");
  const kinds = new Proxy({}, { get: () => 0 });
  const compiler = new Proxy({ typeSyntaxKinds: kinds }, {
    get: (target, name) => target[name] ?? (() => () => {}),
  });
  let received;
  const consumer = {
    manifest: { id: "test/consumer", version: "0.0.1", apiVersion: nominalTypesPlugin.manifest.apiVersion, requires: ["nominal-types"] },
    facets: { compiler: { activate: context => { received = context.dependencies.get("nominal-types/adt"); } } },
  };
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  const { ts } = require("../../test-support/compile.cjs");
  const host = new TSPPPluginHost({ compilerVersion: "0.0.0", logger, compiler, ts });
  host.register(nominalTypesPlugin).register(consumer);
  host.activateAll();
  assert.equal(received, nominalTypesADTAPI);
});
