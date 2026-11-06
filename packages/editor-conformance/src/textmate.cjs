// The grammars as VS Code runs them: the real TextMate engine, the real TypeScript grammar, and the plugin contributions
// injected the way the extension manifest injects them.
const fs = require("node:fs");
const path = require("node:path");
const vsctm = require("vscode-textmate");
const oniguruma = require("vscode-oniguruma");

const extensionRoot = path.resolve(__dirname, "../../vscode-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionRoot, "package.json"), "utf8"));

function grammarFiles() {
  const files = new Map([["source.ts", require.resolve("tm-grammars/grammars/typescript.json")]]);
  for (const { scopeName, path: relative } of manifest.contributes.grammars) files.set(scopeName, path.join(extensionRoot, relative));
  return files;
}

const enginePromises = new Map();
async function createEngine(scope) {
  const wasm = fs.readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
  await oniguruma.loadWASM(wasm);
  const files = grammarFiles();
  const injections = manifest.contributes.grammars.filter(grammar => grammar.injectTo?.includes("source.tspp")).map(grammar => grammar.scopeName);
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: patterns => new oniguruma.OnigScanner(patterns),
      createOnigString: text => new oniguruma.OnigString(text),
    }),
    loadGrammar: async scopeName => {
      const file = files.get(scopeName);
      return file ? vsctm.parseRawGrammar(fs.readFileSync(file, "utf8"), `${scopeName}.json`) : null;
    },
    getInjections: scopeName => (scopeName === "source.tspp" ? injections : undefined),
  });
  return registry.loadGrammar(scope);
}

/** Every token of `text` as `{ start, end, scopes }`, with offsets into `text`. */
async function tokenizeScope(text, scope) {
  if (!enginePromises.has(scope)) enginePromises.set(scope, createEngine(scope));
  const grammar = await enginePromises.get(scope);
  const tokens = [];
  let state = vsctm.INITIAL;
  const pattern = /\r\n|\n|\r|$/g;
  let lineStart = 0;
  for (;;) {
    pattern.lastIndex = lineStart;
    const match = pattern.exec(text);
    const line = text.slice(lineStart, match.index);
    const result = grammar.tokenizeLine(line, state);
    for (const token of result.tokens) {
      if (token.startIndex < line.length) tokens.push({ start: lineStart + token.startIndex, end: lineStart + Math.min(token.endIndex, line.length), scopes: token.scopes });
    }
    state = result.ruleStack;
    if (!match[0]) return tokens;
    lineStart = match.index + match[0].length;
  }
}

const tokenize = text => tokenizeScope(text, "source.tspp");

module.exports = { tokenize, tokenizeScope };
