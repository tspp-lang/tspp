// Checks the relations between plugins that docs/core-restoration-plan.md allows ("插件间关系"): only one-way
// dependencies declared in manifests may last. Keyword conflicts, dependency cycles, and tests that lean on plugins
// they never declared are reported here. Existing violations are listed with the plan step that removes them; a new
// violation fails, and so does a listed one that has been fixed, so that the list only shrinks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { allPlugins } = require("./plugins.cjs");

const plugins = allPlugins();
const manifests = plugins.map(({ plugin }) => plugin.manifest);
const byId = new Map(manifests.map(manifest => [manifest.id, manifest]));

const knownKeywordConflicts = {};

const knownUndeclaredTestDependencies = {};

// Plugin ids are not always the package directory name (`formal-verification/z3`), so map both ways.
const shortName = id => id.split("/")[0].replace(/^type-system$/, "dependent-types");

function assertMatchesKnown(actual, known, describe) {
  const actualKeys = Object.keys(actual).sort();
  const knownKeys = Object.keys(known).sort();
  for (const key of actualKeys) {
    assert.ok(key in known, `New ${describe}: ${key} (${actual[key].join(", ")}). Resolve it; see docs/core-restoration-plan.md.`);
    assert.deepEqual(actual[key], known[key], `The ${describe} ${key} changed.`);
  }
  for (const key of knownKeys) {
    assert.ok(key in actual, `The ${describe} ${key} is resolved: remove it from the known list.`);
  }
}

test("every plugin declares the syntax it claims", () => {
  for (const manifest of manifests) {
    assert.ok(Array.isArray(manifest.syntax?.keywords), `${manifest.id} has no syntax.keywords`);
    const seen = new Set();
    for (const { keyword, position } of manifest.syntax.keywords) {
      assert.ok(keyword && position, `${manifest.id} declares an incomplete keyword`);
      const key = `${keyword} @ ${position}`;
      assert.ok(!seen.has(key), `${manifest.id} declares ${key} twice`);
      seen.add(key);
    }
  }
});

test("no two plugins claim the same keyword in the same position", () => {
  const claims = {};
  for (const manifest of manifests) {
    for (const { keyword, position } of manifest.syntax?.keywords ?? []) {
      (claims[`${keyword} @ ${position}`] ??= []).push(shortName(manifest.id));
    }
  }
  const conflicts = Object.fromEntries(
    Object.entries(claims).filter(([, owners]) => owners.length > 1).map(([key, owners]) => [key, owners.sort()]),
  );
  assertMatchesKnown(conflicts, knownKeywordConflicts, "keyword conflict");
});

test("dependencies name installed plugins and form no cycle", () => {
  const dependencies = manifest => [...(manifest.requires ?? []), ...(manifest.optionalDependencies ?? [])];
  for (const manifest of manifests) {
    for (const dependency of dependencies(manifest)) {
      assert.ok(byId.has(dependency), `${manifest.id} depends on unknown plugin '${dependency}'`);
    }
  }
  const state = new Map();
  const visit = (id, trail) => {
    if (state.get(id) === "done") return;
    // Plugins that share an internal model in both directions belong in one plugin.
    assert.notEqual(state.get(id), "active", `Dependency cycle: ${[...trail, id].join(" -> ")}. Merge these plugins.`);
    state.set(id, "active");
    for (const dependency of dependencies(byId.get(id))) visit(dependency, [...trail, id]);
    state.set(id, "done");
  };
  for (const manifest of manifests) visit(manifest.id, []);
});

test("plugin tests load only the plugins they depend on", () => {
  const directoryToId = new Map(plugins.map(({ packageDirectory, plugin }) => [path.basename(packageDirectory), plugin.manifest.id]));
  const closure = id => {
    const result = new Set();
    const pending = [id];
    while (pending.length) {
      const manifest = byId.get(pending.pop());
      for (const dependency of [...(manifest.requires ?? []), ...(manifest.optionalDependencies ?? [])]) {
        if (!result.has(dependency)) result.add(dependency), pending.push(dependency);
      }
    }
    return result;
  };
  const undeclared = {};
  for (const { packageDirectory, plugin } of plugins) {
    const testDirectory = path.join(packageDirectory, "test");
    if (!fs.existsSync(testDirectory)) continue;
    const used = new Set();
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"));
    for (const name of Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })) {
      const match = /^@tspp\/plugin-(.+)$/.exec(name);
      if (match && directoryToId.has(match[1])) used.add(directoryToId.get(match[1]));
    }
    for (const file of fs.readdirSync(testDirectory).filter(file => /\.c?js$/.test(file))) {
      const text = fs.readFileSync(path.join(testDirectory, file), "utf8");
      for (const [, directory] of text.matchAll(/require\(["'](?:\.\.\/\.\.\/|@tspp\/plugin-)([\w-]+)/g)) {
        if (directoryToId.has(directory)) used.add(directoryToId.get(directory));
      }
    }
    used.delete(plugin.manifest.id);
    const allowed = closure(plugin.manifest.id);
    const extra = [...used].filter(id => !allowed.has(id)).map(shortName).sort();
    if (extra.length) undeclared[shortName(plugin.manifest.id)] = extra;
  }
  assertMatchesKnown(undeclared, knownUndeclaredTestDependencies, "undeclared test dependency");
});
