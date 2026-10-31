const assert = require("node:assert/strict");
const test = require("node:test");
const { formalVerificationAnalyzer } = require("../dist");

const labeled = (text, start = 0) => ({ kind: 256, start, end: start + text.length, text, children: [] });
const input = nodes => ({
  currentDirectory: process.cwd(),
  rootFileNames: ["proof.tspp"],
  syntaxKinds: { sourceFile: 308, labeledStatement: 256 },
  sourceFiles: [{
    fileName: "proof.tspp",
    text: nodes.map(node => node.text).join("\n"),
    root: { kind: 308, start: 0, end: 100, text: "", children: nodes },
  }],
});

test("proves and rejects arithmetic assertions through Z3", async () => {
  const diagnostics = await formalVerificationAnalyzer.analyze(input([
    labeled("assert: 1n + 1n === 2n;"),
    labeled("assert: 2 * 3 < 5;", 30),
  ]));
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, 19002);
  assert.match(diagnostics[0].message, /could not be proved/);
});
