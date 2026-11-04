// A small independent lexer for TS++ source. It knows nothing about plugins beyond treating their words as identifiers,
// which is what makes it useful: it says where comments, strings and code really are, whatever the grammar believes.
const reserved = new Set(("break case catch class const continue debugger default delete do else enum export extends false finally for function if import in "
  + "instanceof new null return super switch this throw true try typeof var void while with as implements interface let package private protected public "
  + "static yield any boolean constructor declare get module require number set string symbol type from of async await abstract infer is keyof namespace "
  + "never readonly unique unknown bigint object override satisfies accessor undefined out").split(" "));
const identifierStart = /[A-Za-z_$\u0080-￿]/;
const identifierPart = /[\w$\u0080-￿]/;

/** Splits text into `{ kind, start, end, text, depth }`: comment, string, regex, number, identifier or punctuation. */
function lex(text) {
  const tokens = [];
  const templates = []; // brace depth at which each open `${` returns to its template
  let depth = 0;
  let index = 0;
  const push = (kind, start, end) => tokens.push({ kind, start, end, text: text.slice(start, end), depth });
  const previousCode = () => {
    for (let i = tokens.length - 1; i >= 0; i--) if (tokens[i].kind !== "comment") return tokens[i];
    return undefined;
  };
  const templateChunk = (start, from) => {
    let i = from;
    while (i < text.length) {
      if (text[i] === "\\") i += 2;
      else if (text[i] === "`") {
        push("string", start, i + 1);
        return i + 1;
      }
      else if (text[i] === "$" && text[i + 1] === "{") {
        push("string", start, i);
        push("punctuation", i, i + 2);
        templates.push(depth);
        depth++;
        return i + 2;
      }
      else i++;
    }
    push("string", start, text.length);
    return text.length;
  };
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (/\s/.test(char)) index++;
    else if (char === "/" && next === "/") {
      let end = index;
      while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
      push("comment", index, end);
      index = end;
    }
    else if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const end = close < 0 ? text.length : close + 2;
      push("comment", index, end);
      index = end;
    }
    else if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") end += text[end] === "\\" ? 2 : 1;
      push("string", index, Math.min(end + 1, text.length));
      index = end + 1;
    }
    else if (char === "`") index = templateChunk(index, index + 1);
    else if (char === "}" && templates.length && templates.at(-1) === depth - 1) {
      depth--;
      templates.pop();
      push("punctuation", index, index + 1);
      index = templateChunk(index + 1, index + 1);
    }
    else if (char === "/" && startsRegex(previousCode())) {
      let end = index + 1;
      let inClass = false;
      while (end < text.length && text[end] !== "\n" && (inClass || text[end] !== "/")) {
        if (text[end] === "\\") end++;
        else if (text[end] === "[") inClass = true;
        else if (text[end] === "]") inClass = false;
        end++;
      }
      end++;
      while (end < text.length && identifierPart.test(text[end])) end++;
      push("regex", index, end);
      index = end;
    }
    else if (identifierStart.test(char)) {
      let end = index + 1;
      while (end < text.length && identifierPart.test(text[end])) end++;
      push("identifier", index, end);
      index = end;
    }
    else if (/\d/.test(char)) {
      let end = index + 1;
      while (end < text.length && /[\w.]/.test(text[end])) end++;
      push("number", index, end);
      index = end;
    }
    else {
      if (char === "}" || char === ")" || char === "]") depth--;
      push("punctuation", index, index + 1);
      if (char === "{" || char === "(" || char === "[") depth++;
      index++;
    }
  }
  return tokens;
}

function startsRegex(previous) {
  if (!previous) return true;
  if (previous.kind === "identifier") return ["return", "typeof", "case", "in", "of", "do", "else"].includes(previous.text);
  if (previous.kind !== "punctuation") return false;
  return ![")", "]", "}"].includes(previous.text);
}

/**
 * Top-level statements: chunks of the file that start at column zero, at bracket depth zero, right after a `;` or `}`.
 * Comments in front of a statement belong to it.
 */
function topLevelStatements(text, tokens = lex(text)) {
  const starts = [0];
  let previous;
  let pendingCommentStart;
  for (const token of tokens) {
    const atLineStart = token.start === 0 || text[token.start - 1] === "\n";
    if (token.kind === "comment") {
      if (pendingCommentStart === undefined && atLineStart && token.depth === 0 && (!previous || previous.text === ";" || previous.text === "}")) pendingCommentStart = token.start;
      continue;
    }
    if (atLineStart && token.depth === 0 && previous && (previous.text === ";" || previous.text === "}") && token.text !== "}" && token.text !== "in") starts.push(pendingCommentStart ?? token.start);
    pendingCommentStart = undefined;
    previous = token;
  }
  return starts.map((start, i) => ({ start, end: starts[i + 1] ?? text.length, text: text.slice(start, starts[i + 1] ?? text.length) }));
}

module.exports = { lex, topLevelStatements, reserved };
