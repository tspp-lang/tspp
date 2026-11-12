// The bracket scans the contract parser relies on. Their bounds were once proved by their own `ensures` clauses; these
// tests hold the same bounds, and the brackets they find, against a direct definition on every position of many texts.
const assert = require("node:assert/strict");
const test = require("node:test");
const { matchingClose, matchingOpen } = require("../dist/contracts");

/** Where the bracket at `start` is balanced, scanning by `step`: the first position the depth returns to zero. */
function reference(code, start, step, same, other) {
  let depth = 0;
  for (let index = start; index >= 0 && index < code.length; index += step) {
    if (code[index] === same) depth++;
    else if (code[index] === other && --depth === 0) return index;
  }
  return -1;
}

/** Deterministic texts of brackets and other characters, from empty to unbalanced in both directions. */
function* texts() {
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  yield* ["", "(", ")", "()", ")(", "(()", "())", "((a)(b))", "{[(])}"];
  for (let count = 0; count < 400; count++) {
    const length = Math.floor(random() * 24);
    yield Array.from({ length }, () => "(){}x "[Math.floor(random() * 6)]).join("");
  }
}

test("matchingClose stays inside the text, at or after its start, and finds the balancing bracket", () => {
  for (const code of texts()) {
    for (let open = 0; open < code.length; open++) {
      for (const [opening, closing] of [["(", ")"], ["{", "}"]]) {
        const result = matchingClose(code, open, opening, closing);
        assert.ok(result === -1 || open <= result && result < code.length, `${JSON.stringify(code)} from ${open}: ${result}`);
        assert.equal(result, reference(code, open, 1, opening, closing), `${JSON.stringify(code)} from ${open}`);
      }
    }
  }
});

test("matchingOpen stays inside the text, at or before its start, and finds the balancing bracket", () => {
  for (const code of texts()) {
    for (let close = 0; close < code.length; close++) {
      for (const [opening, closing] of [["(", ")"], ["{", "}"]]) {
        const result = matchingOpen(code, close, opening, closing);
        assert.ok(result === -1 || 0 <= result && result <= close, `${JSON.stringify(code)} from ${close}: ${result}`);
        assert.equal(result, reference(code, close, -1, closing, opening), `${JSON.stringify(code)} from ${close}`);
      }
    }
  }
});
