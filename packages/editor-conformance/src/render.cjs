// What a reader ends up seeing: a semantic token wins over the TextMate scopes, and the theme turns scopes into a colour.
// Nothing here decides which colour anything should be. Two pieces of code render alike when they get the same colour in
// every theme below, so "alike" does not hinge on one theme happening to merge two scopes.
const themes = ["dark-plus", "light-plus", "monokai", "one-dark-pro"].map(name => compileTheme(require(`tm-themes/themes/${name}.json`)));

/** The semantic token classes tsserver reports, in `classifier2020` order. */
const semanticTypes = ["class", "enum", "interface", "namespace", "typeParameter", "type", "parameter", "variable", "enumMember", "property", "function", "member"];
const semanticModifiers = ["declaration", "static", "async", "readonly", "defaultLibrary", "local"];

/** VS Code's default fallback from semantic classes to TextMate scopes (`tokenClassificationRegistry`), first match wins. */
const semanticScopes = {
  class: ["entity.name.type.class", "support.class"],
  enum: ["entity.name.type.enum"],
  interface: ["entity.name.type.interface"],
  namespace: ["entity.name.namespace"],
  typeParameter: ["entity.name.type.parameter"],
  type: ["entity.name.type", "support.type"],
  parameter: ["variable.parameter"],
  variable: ["variable.other.readwrite", "entity.name.variable"],
  "variable.readonly": ["variable.other.constant"],
  "variable.defaultLibrary": ["support.variable"],
  "variable.readonly.defaultLibrary": ["support.constant"],
  enumMember: ["variable.other.enummember"],
  property: ["variable.other.property"],
  "property.readonly": ["variable.other.constant.property"],
  "property.defaultLibrary": ["support.variable.property"],
  "property.readonly.defaultLibrary": ["support.constant.property"],
  function: ["entity.name.function", "support.function"],
  "function.defaultLibrary": ["support.function"],
  member: ["entity.name.function.member", "support.function"],
  "member.defaultLibrary": ["support.function"],
  "class.defaultLibrary": ["support.class"],
};

function compileTheme(theme) {
  const rules = [];
  for (const { scope, settings } of theme.tokenColors) {
    if (!scope || !settings?.foreground) continue;
    for (const selector of Array.isArray(scope) ? scope : scope.split(",")) {
      const parts = selector.trim().split(/\s+/).filter(Boolean);
      if (parts.length && !selector.includes("-")) rules.push({ parts, foreground: settings.foreground.toLowerCase() });
      else if (parts.length && !parts.includes("-")) rules.push({ parts, foreground: settings.foreground.toLowerCase() });
    }
  }
  const editor = theme.colors?.["editor.foreground"] ?? "default";
  return { rules, fallback: editor.toLowerCase(), cache: new Map() };
}

const matchesScope = (selector, scope) => scope === selector || scope.startsWith(`${selector}.`);

/** How specifically a theme selector matches a scope stack, or 0: the innermost matched scope, then the selector's length. */
function matchScore(parts, scopes) {
  let at = scopes.length - 1;
  while (at >= 0 && !matchesScope(parts.at(-1), scopes[at])) at--;
  if (at < 0) return 0;
  const innermost = at;
  for (let i = parts.length - 2; i >= 0; i--) {
    at--;
    while (at >= 0 && !matchesScope(parts[i], scopes[at])) at--;
    if (at < 0) return 0;
  }
  return (innermost + 1) * 10_000 + parts.at(-1).length * 100 + parts.length;
}

function foreground(theme, scopes) {
  const key = scopes.join(" ");
  const cached = theme.cache.get(key);
  if (cached) return cached;
  let best = 0;
  let color = theme.fallback;
  for (const rule of theme.rules) {
    const score = matchScore(rule.parts, scopes);
    if (score >= best && score > 0) {
      best = score;
      color = rule.foreground;
    }
  }
  theme.cache.set(key, color);
  return color;
}

/** The colours of a TextMate scope stack across all themes, as one comparable string. */
const styleOfScopes = scopes => themes.map(theme => foreground(theme, scopes)).join(" ");

/** Decodes tsserver's packed type-and-modifier number into a semantic class such as `variable.readonly`. */
function semanticClass(packed) {
  const type = semanticTypes[(packed >> 8) - 1];
  const modifiers = semanticModifiers.filter((_, bit) => packed & (1 << bit)).filter(modifier => modifier === "readonly" || modifier === "defaultLibrary");
  return [type, ...modifiers].join(".");
}

/** The colours of a semantic class across all themes. A semantic class renders alike wherever it stands. */
function styleOfSemantic(name) {
  const candidates = semanticScopes[name] ?? semanticScopes[name.split(".")[0]];
  return themes.map(theme => {
    const themed = candidates.find(scope => theme.rules.some(rule => matchScore(rule.parts, ["source.tspp", scope]) > 0));
    return themed ? foreground(theme, ["source.tspp", themed]) : theme.fallback;
  }).join(" ");
}

/** Tokens covering a range, for callers that walk tokens in order. */
function tokensIn(tokens, start, end) {
  return tokens.filter(token => token.start < end && token.end > start);
}

module.exports = { styleOfScopes, styleOfSemantic, semanticClass, tokensIn };
