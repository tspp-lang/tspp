// Rules for the TextMate layer alone, which is all an editor shows before semantic tokens arrive and all it shows in a
// theme without semantic highlighting. They compare the grammars with the lexer and with themselves, never with a colour.
const { lex, topLevelStatements } = require("./lexer.cjs");
const { tokenize } = require("./textmate.cjs");
const { styleOfScopes, tokensIn } = require("./render.cjs");
const { finding } = require("./findings.cjs");

const injected = scope => scope !== "source.tspp" && scope.endsWith(".tspp");
const display = text => JSON.stringify(text.length > 40 ? `${text.slice(0, 37)}...` : text);

/** A plugin grammar stays out of comments and strings, and the grammar agrees with the lexer about where they are. */
function checkRegions(relative, text, lexed, tmTokens, findings) {
  for (const token of lexed) {
    const covering = tokensIn(tmTokens, token.start, token.end);
    if (token.kind === "comment" || token.kind === "string") {
      const wanted = token.kind === "comment" ? "comment" : "string";
      const wrong = covering.find(item => text.slice(item.start, item.end).trim() && !item.scopes.some(scope => scope.startsWith(wanted)));
      if (wrong) findings.push(finding(`grammar/${wanted}-recognized`, relative, text, wrong.start, `${display(text.slice(wrong.start, wrong.end))} is a ${wanted} but has scopes ${wrong.scopes.slice(1).join(" ")}`));
      // Scopes outside the comment or string, like the body of a declaration around it, don't touch it.
      const scopesInside = item => item.scopes.slice(item.scopes.findIndex(scope => scope.startsWith(wanted)));
      const invaded = covering.find(item => scopesInside(item).some(injected));
      if (invaded) findings.push(finding(`grammar/${wanted}-untouched`, relative, text, invaded.start, `${display(text.slice(invaded.start, invaded.end))} inside a ${wanted} has ${scopesInside(invaded).filter(injected).join(" ")}`));
    }
    else {
      const swallowed = covering.find(item => {
        const lastString = item.scopes.findLastIndex(scope => scope.startsWith("string") || scope.startsWith("comment"));
        return lastString >= 0 && !item.scopes.slice(lastString).some(scope => scope.startsWith("meta.template.expression") || scope.startsWith("meta.embedded"));
      });
      if (swallowed) findings.push(finding("grammar/code-is-code", relative, text, token.start, `code ${display(token.text)} is scoped as ${swallowed.scopes.at(-1)}`));
    }
  }
}

/** The grammar colours a word as one piece. */
function checkWholeWords(relative, text, lexed, tmTokens, findings) {
  for (const token of lexed) {
    if (token.kind !== "identifier") continue;
    const covering = tokensIn(tmTokens, token.start, token.end);
    if (new Set(covering.map(item => styleOfScopes(item.scopes))).size > 1) {
      findings.push(finding("grammar/whole-words", relative, text, token.start, `${display(token.text)} is split into ${covering.map(item => display(text.slice(item.start, item.end))).join(" ")}`));
    }
  }
}

/** The style of each code word and punctuation of a piece of text, in order. */
async function wordStyles(text, base = 0) {
  const tmTokens = await tokenize(text);
  return lex(text).filter(token => token.kind !== "comment").map(token => {
    const first = tokensIn(tmTokens, token.start, token.end)[0];
    return { text: token.text, start: base + token.start, style: first ? styleOfScopes(first.scopes) : "", scopes: first?.scopes ?? [] };
  });
}

function firstDifference(left, right) {
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    if (left[i]?.text !== right[i]?.text || left[i]?.style !== right[i]?.style) return i;
  }
  return -1;
}

/** A statement renders the same wherever it stands: anything else means an earlier statement left the grammar in a bad state. */
async function checkIsolation(relative, text, findings) {
  const statements = topLevelStatements(text);
  if (statements.length < 2) return;
  const inContext = await wordStyles(text);
  let reported = 0;
  for (const statement of statements) {
    const alone = await wordStyles(statement.text, statement.start);
    const here = inContext.filter(word => word.start >= statement.start && word.start < statement.end);
    const at = firstDifference(here, alone);
    if (at < 0) continue;
    if (reported++ < 3) {
      const word = here[at] ?? alone[at];
      findings.push(finding("grammar/statement-isolation", relative, text, word.start, `${display(word.text)} renders differently after the earlier statements (${here[at]?.scopes.at(-1)} there, ${alone[at]?.scopes.at(-1)} alone)`));
    }
  }
}

/** Adding `export` in front of a declaration changes nothing about the declaration. */
async function checkExportPrefix(relative, text, findings) {
  for (const statement of topLevelStatements(text)) {
    const code = lex(statement.text).find(token => token.kind !== "comment");
    if (!code || !["type", "interface", "class", "function", "const", "let", "data", "newtype", "def", "abstract", "enum", "async", "declare", "macro"].includes(code.text)) continue;
    // `macro check(x);` is a call, which can't be exported.
    if (code.text === "macro" && !/^\s*macro\s+function\b/.test(statement.text.slice(code.start))) continue;
    const prefix = statement.text.slice(0, code.start);
    const rest = statement.text.slice(code.start);
    const plain = await wordStyles(prefix + rest, statement.start);
    const exported = (await wordStyles(`${prefix}export ${rest}`, statement.start)).filter((_, index) => index !== lex(prefix).filter(token => token.kind !== "comment").length);
    const at = firstDifference(plain, exported);
    if (at >= 0) {
      const word = plain[at] ?? exported[at];
      findings.push(finding("grammar/export-prefix", relative, text, word.start, `${display(word.text)} renders differently with export (${plain[at]?.scopes.at(-1)} without, ${exported[at]?.scopes.at(-1)} with)`));
    }
  }
}

async function checkFileGrammar(relative, text) {
  const findings = [];
  const lexed = lex(text);
  const tmTokens = await tokenize(text);
  checkRegions(relative, text, lexed, tmTokens, findings);
  checkWholeWords(relative, text, lexed, tmTokens, findings);
  await checkIsolation(relative, text, findings);
  await checkExportPrefix(relative, text, findings);
  return findings;
}

/**
 * Plugin syntax around ordinary code leaves that code alone. Each case marks a region with `§` in TS++ source and in
 * equivalent TypeScript; the regions must render word for word alike.
 */
async function checkParityCase(name, testCase) {
  const region = async source => {
    const [before, inside] = source.split("§");
    const words = await wordStyles(source.replaceAll("§", ""));
    return words.filter(word => word.start >= before.length && word.start < before.length + inside.length);
  };
  const tspp = await region(testCase.tspp);
  const ts = await region(testCase.ts);
  const at = firstDifference(tspp, ts);
  if (at < 0) return [];
  const message = `${JSON.stringify(tspp[at]?.text ?? ts[at]?.text)}: ${tspp[at]?.scopes.slice(1).join(" ")} in TS++ but ${ts[at]?.scopes.slice(1).join(" ")} in TypeScript`;
  return [{ rule: "grammar/parity", location: name, message }];
}

module.exports = { checkFileGrammar, checkParityCase, wordStyles };
