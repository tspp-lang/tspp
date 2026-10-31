import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = path.resolve(extensionRoot, "../plugins");
const require = createRequire(import.meta.url);
const patterns = [];

for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packagePath = path.join(pluginsRoot, entry.name, "package.json");
  if (!fs.existsSync(packagePath)) continue;
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  let plugin;
  try {
    plugin = require(path.join(pluginsRoot, entry.name));
    plugin = plugin.default ?? plugin;
  } catch (error) {
    if (packageJson.files?.includes("editor")) {
      throw new Error(`Cannot load editor-contributing plugin '${packageJson.name ?? entry.name}'. Build it before the VS Code extension.`, { cause: error });
    }
    continue;
  }
  for (const grammarPath of plugin.facets?.editor?.grammars ?? []) {
    const grammar = JSON.parse(fs.readFileSync(path.resolve(path.dirname(packagePath), grammarPath), "utf8"));
    patterns.push(...(grammar.patterns ?? []));
  }
}

const output = {
  $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  name: "TS++ plugin contributions",
  scopeName: "source.tspp.plugins",
  injectionSelector: "L:source.tspp",
  patterns,
};
fs.writeFileSync(
  path.join(extensionRoot, "syntaxes/tspp-plugins.tmLanguage.json"),
  `${JSON.stringify(output, null, 2)}\n`,
);
