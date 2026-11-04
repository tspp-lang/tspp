// Rules for what the language service answers: which semantic class and Quick Info each word of the examples gets. The
// word's symbol comes from "go to definition", its role from the first words of its Quick Info, and nothing is compared
// with an expected colour. What a thing is must decide how it renders; where it stands must not.
const { lex, reserved, topLevelStatements } = require("./lexer.cjs");
const { tokenize } = require("./textmate.cjs");
const { styleOfScopes, styleOfSemantic, semanticClass, tokensIn } = require("./render.cjs");
const { locator } = require("./tsserver.cjs");
const { finding } = require("./findings.cjs");

/**
 * Roles TypeScript itself reports, whose colour may depend on the type. A `const` holding a function renders as a
 * function, for one, so only plugin roles and type parameters must be uniform across all symbols.
 */
const typeDependentRoles = new Set(["const", "let", "var", "function", "class", "enum", "interface", "namespace", "module", "alias", "parameter", "property", "method", "local var", "local function", "getter", "setter", "accessor", "constructor", "enum member", "import", "using", "await using", "type"]);

/** The kind of thing a Quick Info says it describes: `(data constructor) Some...` is `data constructor`, `newtype X = ...` is `newtype`. */
function roleOf(display) {
  const parenthesized = /^\(([^)]+)\)/.exec(display);
  if (parenthesized) return parenthesized[1];
  return /^(?:newtype|data)\b/.exec(display)?.[0];
}

const isName = token => token.kind === "identifier" && !reserved.has(token.text);

/** Words of code in a text, for telling what a hover invented from what the author wrote. */
const wordsOf = text => new Set(lex(text).filter(token => token.kind === "identifier").map(token => token.text));

function statementAt(statements, offset) {
  return statements.find(statement => statement.start <= offset && offset < statement.end);
}

/**
 * Everything the service says about every name in one open file. `occurrences` of a project are later grouped by symbol
 * and by role, across files.
 */
async function inspectFile(server, project, source) {
  const { file, relative, text } = source;
  const findings = [];
  const occurrences = [];
  const { at, offsetOf } = locator(text);
  await server.open(file, text, project.root);

  const { response, spans } = await server.semanticSpans(file, text.length);
  if (!response.success) findings.push(finding("service/semantic-tokens", relative, text, 0, `request failed: ${String(response.message).split("\n")[0]}`));
  const lexed = lex(text);
  const words = new Map(lexed.filter(token => token.kind === "identifier").map(token => [token.start, token]));
  const semanticAt = new Map();
  let previousEnd = -1;
  for (let i = 0; i < spans.length; i += 3) {
    const [start, length, packed] = [spans[i], spans[i + 1], spans[i + 2]];
    const word = words.get(start);
    const shown = JSON.stringify(text.slice(start, start + length));
    if (start < previousEnd) findings.push(finding("service/semantic-order", relative, text, start, `token ${shown} starts before the previous one ended; LSP drops or misplaces tokens that are out of order`));
    else if (!word || word.end !== start + length) findings.push(finding("service/semantic-range", relative, text, start, `token ${shown} is not a whole word of the source`));
    previousEnd = Math.max(previousEnd, start + length);
    semanticAt.set(start, semanticClass(packed));
  }

  const tmTokens = await tokenize(text);
  const statements = topLevelStatements(text, lexed);
  for (const token of lexed) {
    if (token.kind !== "identifier") continue;
    const tm = tokensIn(tmTokens, token.start, token.end)[0];
    const semantic = semanticAt.get(token.start);
    const style = semantic ? styleOfSemantic(semantic) : styleOfScopes(tm.scopes);
    // Code written to fail shows what the checker recovered to, and a property that doesn't exist has nothing to show.
    const expectsError = text.slice(0, token.start).split("\n").slice(-3, -1).some(line => line.includes("@ts-expect-error"));
    const position = at(token.start);
    const quick = await server.request("quickinfo", { file, ...position });
    const display = quick.success ? quick.body.displayString : undefined;
    const name = JSON.stringify(token.text);

    if (!quick.success && !/No content/.test(quick.message ?? "")) {
      findings.push(finding("hover/request", relative, text, token.start, `${name}: ${String(quick.message).split("\n")[0]}`));
    }
    if (display !== undefined) {
      const span = { start: offsetOf(quick.body.start), end: offsetOf(quick.body.end) };
      if (isName(token) && (span.start > token.start || span.end < token.end)) findings.push(finding("hover/span", relative, text, token.start, `hover for ${name} covers ${JSON.stringify(text.slice(span.start, span.end))}`));
      // A declared `any`, like the parameters of `console.log`, is what the library says; a name typed `any` is a gap.
      if (!expectsError && /^any$|\(Missing\)|[:=]\s*any\s*$/.test(display) && !/^\((?:method|function)\)|^function\b/.test(display) && !/\bany\b|@ts-expect-error/.test(statementAt(statements, token.start)?.text ?? "")) {
        findings.push(finding("hover/no-any", relative, text, token.start, `${name} shows ${JSON.stringify(display.slice(0, 80))}`));
      }
      if ((display.match(/\b(?:__\w+|_tag|_values)\b/g) ?? []).some(word => !wordsOf(text).has(word))) findings.push(finding("hover/no-internals", relative, text, token.start, `${name} shows ${JSON.stringify(display.slice(0, 80))}`));
      // A declaration's Quick Info repeats what its author wrote. Words from nowhere come from the lowering.
      const statement = statementAt(statements, token.start);
      if (statement && /^(?:type|newtype|data)\s/.test(display) && display.split(/[\s<=]/)[1] === token.text && new RegExp(`\\b${display.split(/\s/)[0]}\\s+${token.text.replaceAll("$", "\\$")}\\b`).test(statement.text)) {
        // Showing an alias expanded is what TypeScript does and is useful; only the words of a lowering give it away.
        const invented = expectsError ? [] : [...wordsOf(display)].filter(word => loweringWords.has(word) && !wordsOf(statement.text).has(word));
        if (invented.length) findings.push(finding("hover/source-level", relative, text, token.start, `${name} shows words its declaration does not have: ${invented.slice(0, 6).join(", ")}`));
      }
      const role = roleOf(display);
      if (role === "type parameter" && / in /.test(display)) {
        const invented = [...wordsOf(display.slice(display.indexOf(" in ") + 4))].filter(word => !wordsOf(statement?.text ?? "").has(word) && !isElaboratedKind(word));
        if (invented.length) findings.push(finding("hover/source-level", relative, text, token.start, `${name} shows words its declaration does not have: ${invented.slice(0, 6).join(", ")}`));
      }
    }
    if (isName(token) && display === undefined && !expectsError) {
      findings.push(finding("hover/present", relative, text, token.start, `${name} has no hover`));
    }

    let symbol;
    if (isName(token)) {
      const definition = await server.request("definition", { file, ...position });
      if (!definition.success && !/No content/.test(definition.message ?? "")) {
        findings.push(finding("service/definition", relative, text, token.start, `${name}: ${String(definition.message).split("\n")[0]}`));
      }
      const target = definition.body?.[0];
      if (target) symbol = `${target.file}:${target.start.line}:${target.start.offset}`;
    }
    occurrences.push({ inImport: /^\s*(?:\/\/[^\n]*\s*)*import\b/.test(statementAt(statements, token.start)?.text ?? ""), relative, text, start: token.start, word: token.text, style, semantic, tmLast: tm.scopes.at(-1), scopes: tm.scopes, role: display === undefined ? undefined : roleOf(display), symbol, isName: isName(token), display });
  }
  return { findings, occurrences };
}

const isPluginScope = scope => scope !== "source.tspp" && scope.endsWith(".tspp");
const loweringWords = new Set(["extends", "infer", "never", "unknown", "any"]);

/** Inferring and showing the kind of a parameter its author left out is what Quick Info is for. */
function isElaboratedKind(word) {
  return /^Type\d*$/.test(word);
}

function describe(item) {
  return `${item.relative}:${lineNumber(item)} ${item.semantic ?? item.tmLast}`;
}

function lineNumber(item) {
  return item.text.slice(0, item.start).split("\n").length;
}

/** Occurrences that differ from the most common style in their group. */
function outliers(items) {
  const counts = new Map();
  for (const item of items) counts.set(item.style, (counts.get(item.style) ?? 0) + 1);
  const common = [...counts].sort((a, b) => b[1] - a[1])[0][0];
  return { common: items.find(item => item.style === common), odd: items.filter(item => item.style !== common) };
}

/** Same symbol, same rendering; same plugin role or keyword, same rendering. */
function checkConsistency(occurrences) {
  const findings = [];
  const group = key => {
    const groups = new Map();
    for (const item of occurrences) {
      const value = key(item);
      if (value) groups.set(value, [...groups.get(value) ?? [], item]);
    }
    return groups;
  };
  // TypeScript's own classifier leaves the names of import clauses unclassified, so they say nothing about TS++.
  occurrences = occurrences.filter(item => !item.inImport);
for (const items of group(item => item.isName && item.symbol && `${item.word}@${item.symbol}`).values()) {
    const { common, odd } = outliers(items);
    // Classes TypeScript itself chooses by context, like a parameter property, are its business; a name the classifier
    // sees in some places and misses in others is ours.
    // With no semantic token at all and no plugin scope, like `smt.f()` beside `smt.T`, the TypeScript grammar decides.
    for (const item of odd.filter(item => (!item.semantic || !common.semantic) && (item.semantic || common.semantic || item.scopes.some(isPluginScope) || common.scopes.some(isPluginScope)))) findings.push(finding("consistency/symbol", item.relative, item.text, item.start, `${JSON.stringify(item.word)} is ${item.semantic ?? item.tmLast} here but ${describe(common)}`));
  }
  for (const [role, items] of group(item => item.isName && item.role && !typeDependentRoles.has(item.role) && item.role !== "TS++ keyword" && item.role)) {
    const { common, odd } = outliers(items);
    // `data Box = Box(value: T)`: the hover names the type, while the word in value position is its constructor.
    for (const item of odd.filter(item => !(role === "data" && item.semantic === "function"))) findings.push(finding("consistency/role", item.relative, item.text, item.start, `${role} ${JSON.stringify(item.word)} is ${item.semantic ?? item.tmLast} here but ${JSON.stringify(common.word)} is ${describe(common)}`));
  }
  for (const [keyword, items] of group(item => item.role === "TS++ keyword" && item.word)) {
    const { common, odd } = outliers(items);
    for (const item of odd) findings.push(finding("consistency/keyword", item.relative, item.text, item.start, `keyword ${JSON.stringify(keyword)} renders as ${item.style} under ${item.scopes.slice(-3).join(" ")} here but as ${common.style} under ${common.scopes.slice(-3).join(" ")} at ${describe(common)}`));
  }
  return findings;
}

const requests = (file, position, text) => [
  ["quickinfo", position],
  ["definitionAndBoundSpan", position],
  ["references", position],
  ["documentHighlights", { ...position, filesToSearch: [file] }],
  ["linkedEditingRange", position],
  ["signatureHelp", position],
  ["completionInfo", position],
  ["format", { line: 1, offset: 1, endLine: 400, endOffset: 1 }],
  ["navtree", {}],
  ["getOutliningSpans", {}],
  ["encodedSemanticClassifications-full", { start: 0, length: text.length, format: "2020" }],
  ["syntacticDiagnosticsSync", {}],
  ["semanticDiagnosticsSync", {}],
  ["suggestionDiagnosticsSync", {}],
];

/**
 * Editing never breaks the service: insert or delete a character at spread-out positions, ask everything an editor asks
 * after a keystroke, and afterwards a file edited that way must answer like the same file freshly opened.
 */
async function checkEditing(server, project, source, { editsPerFile = 24 } = {}) {
  const { file, relative, text } = source;
  const findings = [];
  await server.open(file, text, project.root);
  const seen = new Set();
  const lexed = lex(text);
  const anchors = lexed.filter(token => token.kind !== "comment");
  const step = Math.max(1, Math.floor(anchors.length / editsPerFile));
  let current = text;
  for (let i = 0; i < anchors.length; i += step) {
    const anchor = anchors[i].start;
    const inserting = (i / step) % 2 === 0;
    const { at } = locator(current);
    const before = current;
    if (inserting) {
      await server.change(file, at(anchor), at(anchor), "x");
      current = current.slice(0, anchor) + "x" + current.slice(anchor);
    }
    else {
      await server.change(file, at(anchor), at(anchor + 1), "");
      current = current.slice(0, anchor) + current.slice(anchor + 1);
    }
    const position = locator(current).at(anchor);
    for (const [command, args] of requests(file, position, current)) {
      const response = await server.request(command, { file, ...args });
      if (response.timedOut) {
        findings.push(finding("editing/no-hang", relative, text, anchor, `${command} after ${inserting ? "inserting at" : "deleting at"} ${JSON.stringify(before.slice(Math.max(0, anchor - 12), anchor + 12).replace(/\s+/g, " "))} never answers`));
        return findings;
      }
      if (response.success || /No content/.test(response.message ?? "")) continue;
      const summary = String(response.message).split("\n")[0].replace(/\d+/g, "N");
      const key = `${command} ${summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const trigger = before.slice(Math.max(0, anchor - 12), anchor + 12).replace(/\s+/g, " ");
      findings.push(finding("editing/no-crash", relative, text, anchor, `${command} after ${inserting ? "inserting at" : "deleting at"} ${JSON.stringify(trigger)}: ${summary}`));
      if (server.exited) return findings;
    }
    // Undo, the way an editor sends it, so that every edit starts from the example.
    const undo = locator(current);
    if (inserting) await server.change(file, undo.at(anchor), undo.at(anchor + 1), "");
    else await server.change(file, undo.at(anchor), undo.at(anchor), before[anchor]);
    current = before;
  }
  const edited = await server.semanticSpans(file, text.length);
  await server.close(file);
  await server.open(file, text, project.root);
  const fresh = await server.semanticSpans(file, text.length);
  if (JSON.stringify(edited.spans) !== JSON.stringify(fresh.spans)) {
    findings.push(finding("editing/incremental-matches-fresh", relative, text, 0, `semantic tokens after editing and undoing differ from a fresh open (${edited.spans.length / 3} and ${fresh.spans.length / 3} tokens)`));
  }
  await server.close(file);
  return findings;
}

module.exports = { inspectFile, checkConsistency, checkEditing };
