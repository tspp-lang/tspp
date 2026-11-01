// Registers every feature plugin in this test process, the way a project enabling all of them would.
const fs = require("node:fs");
const path = require("node:path");
const { usePlugins } = require("../../test-support/compile.cjs");

const packageNames = [
  "@tspp/plugin-dependent-types",
  "@tspp/plugin-formal-verification",
  "@tspp/plugin-higher-kinded-types",
  "@tspp/plugin-macros",
  "@tspp/plugin-modern-syntax",
  "@tspp/plugin-nominal-types",
  "@tspp/plugin-operator-sections",
  "@tspp/plugin-static-interface-members",
  "@tspp/plugin-type-computation",
];

// Plugin packages do not export `./package.json`, so walk up from the entry point instead.
function packageDirectoryOf(file) {
  let directory = path.dirname(file);
  while (!fs.existsSync(path.join(directory, "package.json"))) directory = path.dirname(directory);
  return directory;
}

/** Every feature plugin with the directory of its package. */
function allPlugins() {
  return packageNames.map(name => {
    const exports = require(name);
    return {
      packageDirectory: packageDirectoryOf(require.resolve(name)),
      plugin: exports.default ?? Object.values(exports).find(value => value?.manifest),
    };
  });
}

function useAllPlugins() {
  for (const { plugin } of allPlugins()) usePlugins(plugin);
}

module.exports = { allPlugins, useAllPlugins };
