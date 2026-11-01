// Registers every feature plugin in this test process, the way a project enabling all of them would.
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

function useAllPlugins() {
  for (const name of packageNames) {
    const exports = require(name);
    usePlugins(exports.default ?? Object.values(exports).find(value => value?.manifest));
  }
}

module.exports = { useAllPlugins };
