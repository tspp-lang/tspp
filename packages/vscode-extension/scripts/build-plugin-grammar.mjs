// Merges what the feature plugins contribute to the editor into files the extension ships: their grammars, and the
// commands of their views. With --check, fails when a generated file or package.json is out of date instead of writing.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsRoot = path.resolve(extensionRoot, "../plugins");
const require = createRequire(import.meta.url);
const check = process.argv.includes("--check");
const patterns = [];
const artifactViews = [];
const overlayViews = [];

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
      throw new Error(`Cannot load editor-contributing plugin '${packageJson.name ?? entry.name}'. Build the plugin first.\n${error.message}`);
    }
    continue;
  }
  for (const grammarPath of plugin.facets?.editor?.grammars ?? []) {
    const grammar = JSON.parse(fs.readFileSync(path.resolve(path.dirname(packagePath), grammarPath), "utf8"));
    patterns.push(...(grammar.patterns ?? []));
  }
  artifactViews.push(...plugin.facets?.editor?.artifactViews ?? []);
  overlayViews.push(...plugin.facets?.editor?.overlayViews ?? []);
}

const grammar = {
  $schema: "https://raw.githubusercontent.com/martinring/tmlanguage/master/tmlanguage.json",
  name: "TS++ plugin contributions",
  scopeName: "source.tspp.plugins",
  injectionSelector: "L:source.tspp -comment -string, L:meta.template.expression -comment -string.quoted",
  patterns,
};
const contributions = {
  artifactViews: artifactViews.map(({ commandId, artifactKind, emptyMessage }) => ({ commandId, artifactKind, emptyMessage })),
  overlayViews: overlayViews.map(({ id, commandId, progressTitle, emptyMessage }) => ({ id, commandId, progressTitle, emptyMessage })),
};

const problems = [];
for (const [relative, value] of [["syntaxes/tspp-plugins.tmLanguage.json", grammar], ["plugin-contributions.json", contributions]]) {
  const file = path.join(extensionRoot, relative);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (!check) fs.writeFileSync(file, text);
  else if (!fs.existsSync(file) || fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") !== text) problems.push(`${relative} is out of date.`);
}

// VS Code reads commands from package.json before anything runs, so the manifest repeats what the plugins declare.
const declared = new Map(JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8")).contributes.commands.map(({ command, title }) => [command, title]));
for (const { commandId, title } of [...artifactViews, ...overlayViews]) {
  if (declared.get(commandId) !== title) problems.push(`package.json must contribute the command '${commandId}' with the title '${title}'.`);
}

if (problems.length) {
  console.error(`${problems.join("\n")}\nRun 'pnpm --filter tspp-vscode build' and update contributes.commands in package.json.`);
  process.exit(1);
}
