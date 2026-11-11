const assert = require("node:assert/strict");
const test = require("node:test");
const { analyzeSource, expectVerification } = require("./analyze.cjs");

test("checks a counted loop with continue, break and return", async () => {
  await expectVerification({ source: `
function first(start: bigint, end: bigint, skip: bigint, stop: bigint) with {
  ensures: result === -1n || (start <= result && result < end);
}: bigint {
  for (let index = start; index < end; index++) {
    if (index === skip) continue;
    if (index === stop) break;
    return index;
  }
  return -1n;
}
` });
});

test("verifies the matchingClose string scan and rejects an out-of-range return", async () => {
  const source = `
function matchingClose(code: string, open: number, opening: string, closing: string) with {
  numberModel: "safe-integer";
  ensures: result === -1 || (open <= result && result < code.length);
}: number {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === opening) depth++;
    else if (code[index] === closing && --depth === 0) return index;
  }
  return -1;
}
`;
  await expectVerification({ source });
  const messages = await analyzeSource(source.replace("return -1;", "return code.length;"));
  assert.equal(messages.length, 1, messages.join("\n"));
  assert.match(messages[0], /matchingClose postcondition could not be proved\. Counterexample:/);
});

test("verifies a descending string scan and finds a counterexample for close + 1", async () => {
  const source = `
function matchingOpen(code: string, close: number, opening: string, closing: string) with {
  numberModel: "safe-integer";
  ensures: result === -1 || (0 <= result && result <= close);
}: number {
  let depth = 0;
  for (let index = close; index >= 0; index--) {
    if (code[index] === closing) depth++;
    else if (code[index] === opening && --depth === 0) return index;
  }
  return -1;
}
`;
  await expectVerification({ source });
  const messages = await analyzeSource(source.replace("return -1;", "return close + 1;"));
  assert.equal(messages.length, 2, messages.join("\n"));
  assert.match(messages[0], /safe-integer range could not be proved\. Counterexample:/);
  assert.match(messages[1], /matchingOpen postcondition could not be proved\. Counterexample:/);
});

test("compares UTF-16 elements and keeps an out-of-bounds read distinct from the empty string", async () => {
  await expectVerification({ source: String.raw`
function inspect() with { numberModel: "safe-integer"; ensures: result; }: boolean {
  const text = "🙂";
  return text[0] === "\uD83D" && "\uDE42" === text[1] && text[-1] !== "" && text[2] !== "";
}
` });
});

test("increments only on the evaluated side of a condition and distinguishes prefix from postfix", async () => {
  await expectVerification({ source: `
function after(flag: boolean) with {
  numberModel: "safe-integer";
  ensures: (flag && result === 2) || (!flag && result === 0);
}: number {
  let value = 0;
  if (flag && ++value === 1 && value++ === 1) return value;
  return value;
}
` });
});

test("rejects an invalid body bound and an overflowing continue step", async () => {
  await expectVerification({
    source: `function unsafe(open: number, end: number) with {
      numberModel: "safe-integer"; ensures: result;
    }: boolean {
      for (let index = open; index < end; index++) {
        assert: index < open;
      }
      return true;
    }`,
    rejects: /local assertion could not be proved/,
  });
  await expectVerification({
    source: `function overflowing() with {
      numberModel: "safe-integer"; ensures: result;
    }: boolean {
      for (let index = 9007199254740991; index < 9007199254740991n + 1n; index++) continue;
      return true;
    }`,
    rejects: /safe-integer range could not be proved/,
  });
});

test("fails closed when the body changes the induction variable or hides writes", async () => {
  for (const body of ["index = -1n;", "var total = -1n;", "change();"]) {
    await expectVerification({
      source: `function change(): void {}
      function unsupported(end: bigint) with { ensures: result === 0n; }: bigint {
        let total = 0n;
        function change(): void { total = -1n; }
        for (let index = 0n; index < end; index++) { ${body} }
        return total;
      }`,
      rejects: /postcondition cannot be verified because/,
    });
  }
});
