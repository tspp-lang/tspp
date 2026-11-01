// Editor grammar helpers for feature plugin tests. They run each plugin grammar's single-line rules (`match`, and the
// opening `begin` of regions) as JavaScript regular expressions, which is enough to check which scope a keyword gets
// in a representative line of code without loading a TextMate engine.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const posixClasses = { alnum: "A-Za-z0-9", alpha: "A-Za-z", digit: "0-9", space: "\\s", upper: "A-Z", lower: "a-z" };

/** Converts the Oniguruma constructs these grammars use into JavaScript syntax. */
function toJavaScriptRegExp(source) {
  return new RegExp(source.replace(/\[:(\w+):\]/g, (whole, name) => posixClasses[name] ?? whole), "g");
}

function collectRules(node, rules = []) {
  if (!node || typeof node !== "object") return rules;
  if (node.match || node.begin) rules.push(node);
  for (const child of node.patterns ?? []) collectRules(child, rules);
  for (const child of Object.values(node.repository ?? {})) collectRules(child, rules);
  return rules;
}

/** Loads every grammar a plugin's editor facet contributes. */
function loadGrammars(packageDirectory, plugin) {
  return (plugin.facets.editor?.grammars ?? []).map(file => JSON.parse(fs.readFileSync(path.resolve(packageDirectory, file), "utf8")));
}

/** Scopes the grammar assigns within `text`, as `{ text, scope }` pairs for whole matches and named captures. */
function scopesIn(grammars, text) {
  const scopes = [];
  for (const rule of grammars.flatMap(grammar => collectRules(grammar))) {
    const expression = toJavaScriptRegExp(rule.match ?? rule.begin);
    const captures = rule.captures ?? rule.beginCaptures ?? {};
    for (const match of text.matchAll(expression)) {
      if (rule.name && rule.match) scopes.push({ text: match[0], scope: rule.name });
      for (const [index, capture] of Object.entries(captures)) {
        if (capture.name && match[Number(index)] !== undefined) scopes.push({ text: match[Number(index)], scope: capture.name });
      }
    }
  }
  return scopes;
}

/** Asserts that `word` is scoped (with a scope matching `scope`) somewhere in `line`. */
function assertScoped(grammars, line, word, scope = /./) {
  const found = scopesIn(grammars, line).filter(entry => entry.text.trim() === word || entry.text.split(/\s+/).includes(word));
  assert.ok(found.some(entry => scope.test(entry.scope)), `'${word}' is not scoped by ${scope} in: ${line}\nfound: ${JSON.stringify(scopesIn(grammars, line))}`);
}

/** Bare `<` and `>` must stay with TypeScript's contextual grammar, which tells generics from comparisons. */
function assertLeavesAngleBracketsToTypeScript(grammars) {
  const rules = grammars.flatMap(grammar => collectRules(grammar));
  assert.ok(!rules.some(rule => rule.name === "keyword.operator.relational.ts"), "a plugin grammar overrides angle-bracket classification");
}

module.exports = { loadGrammars, scopesIn, assertScoped, assertLeavesAngleBracketsToTypeScript };
