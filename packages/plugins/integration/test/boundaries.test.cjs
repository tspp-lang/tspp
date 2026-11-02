// What ESLint cannot see: words in strings and regular expressions. A plugin must not spell another plugin's id or
// keywords, and a host must not spell any plugin's (docs/plugin-framework.md, "Rules"): each would turn adding or
// renaming a plugin into editing the code that knows about it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { ts } = require("../../test-support/compile.cjs");
const { allPlugins, pluginsRoot } = require("./plugins.cjs");

const packagesRoot = path.resolve(pluginsRoot, "..");
const plugins = allPlugins().map(({ packageDirectory, plugin }) => ({ directory: path.basename(packageDirectory), packageDirectory, manifest: plugin.manifest }));

function sourceFiles(root) {
  if (!fs.existsSync(root)) return [];
  if (fs.statSync(root).isFile()) return [root];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(full);
    return /\.(ts|js|mjs|cjs)$/.test(entry.name) && !/\.d\.ts$|\.test\.[cm]?[jt]s$/.test(entry.name) ? [full] : [];
  });
}

/** The text of a file's string literals, template text, and regular expressions, with import paths left out. */
function literalsOf(file) {
  const sourceFile = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const literals = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteralLike(node) || ts.isRegularExpressionLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      literals.push({ text: node.text, line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return literals;
}

// Words ordinary code uses as well (`data`, `match`, `use`, `let`, `in`) would only produce noise; these only mean a plugin.
const isDistinctive = word => /^[A-Za-z]{5,}$/.test(word) && ts.stringToToken?.(word) === undefined
  && !["match", "assert", "assume"].includes(word) && !/^[A-Z]/.test(word);

function termsOf(plugin) {
  const words = (plugin.manifest.syntax?.keywords ?? []).map(({ keyword }) => keyword).filter(isDistinctive);
  return [...new Set([plugin.manifest.id, plugin.directory, `plugin-${plugin.directory}`, ...words])];
}

const mentions = (text, term) => new RegExp(`(?<![\\w-])${term.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?![\\w-])`).test(text);

function violations(files, terms, allowed = () => false) {
  const found = [];
  for (const file of files) {
    const relative = path.relative(packagesRoot, file).replace(/\\/g, "/");
    for (const { text, line } of literalsOf(file)) {
      for (const term of terms) {
        if (mentions(text, term) && !allowed(relative, term, text)) found.push(`${relative}:${line} spells '${term}' in ${JSON.stringify(text.slice(0, 70))}`);
      }
    }
  }
  return found;
}

test("the scan finds a keyword in the kinds of text that hide one", () => {
  assert.ok(mentions(String.raw`\b(?:type|data|newtype)\s+`, "newtype"));
  assert.ok(mentions("formal-verification/smt", "formal-verification"));
  assert.ok(!mentions("subroutine", "routine"));
  assert.ok(termsOf(plugins.find(plugin => plugin.directory === "nominal-types")).includes("newtype"));
});

test("a plugin spells no other plugin's id or keywords, except a declared dependency's", () => {
  const found = [];
  for (const plugin of plugins) {
    const dependencies = new Set([...plugin.manifest.requires ?? [], ...plugin.manifest.optionalDependencies ?? []]);
    const own = new Set(termsOf(plugin));
    const terms = plugins.filter(other => other !== plugin && !dependencies.has(other.manifest.id)).flatMap(termsOf).filter(term => !own.has(term));
    found.push(...violations(sourceFiles(path.join(plugin.packageDirectory, "src")), terms));
  }
  assert.deepEqual(found, []);
});

// A host adapter gives a plugin what only that host can supply, so it names the plugin on purpose: the playground's
// browser Z3 and its package's macro module stubs. Everything else about a plugin reaches hosts through its manifest and facets.
const hostAdapters = [
  { file: "playground/src/worker/languageWorker.ts", term: "macros", text: /ts-plus-plus\/macros/ },
];

test("hosts spell no plugin's id or keywords", () => {
  const hosts = [
    "vscode-extension/extension.js",
    "language-server/src",
    "compiler/src/compiler/tspp",
    "compiler/src/services/tspp",
    "compiler/src/server/tspp",
    "plugin-sdk/src",
    "playground/src",
  ].flatMap(relative => sourceFiles(path.join(packagesRoot, relative)))
    .filter(file => !file.endsWith("z3Bridge.ts"));
  const allowed = (file, term, text) => hostAdapters.some(adapter => adapter.file === file && adapter.term === term && adapter.text.test(text));
  assert.deepEqual(violations(hosts, plugins.flatMap(termsOf), allowed), []);
});

test("every plugin is listed where a package manifest has to list it", () => {
  const dependenciesOf = relative => {
    const manifest = JSON.parse(fs.readFileSync(path.join(packagesRoot, "..", relative), "utf8"));
    return new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }));
  };
  const packageNames = plugins.map(({ packageDirectory }) => JSON.parse(fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8")).name);
  for (const relative of ["package.json", "packages/playground/package.json", "packages/vscode-extension/package.json", "packages/plugins/integration/package.json"]) {
    const dependencies = dependenciesOf(relative);
    assert.deepEqual(packageNames.filter(name => !dependencies.has(name)), [], `${relative} is missing plugins`);
  }
});
