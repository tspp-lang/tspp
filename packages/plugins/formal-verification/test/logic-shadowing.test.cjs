const assert = require("node:assert/strict");
const test = require("node:test");
const { usePlugins } = require("../../test-support/compile.cjs");
const { formalVerificationAnalyzer, formalVerificationPlugin } = require("../dist");

usePlugins(formalVerificationPlugin);

// Logic libraries are project-wide, so another file's logic function must not replace a local function's contract.
test("checks a local function's contract when another file declares a logic function of the same name", async () => {
  const library = `import * as smt from "ts-plus-plus/plugins/formal-verification/smt";
  const successor = smt.declareFunction([smt.Int], smt.Int);
  smt.axiom([["value", smt.Int]], value => smt.eq(successor(value), smt.add(value, 1n)));`;
  const program = `function successor(value: bigint) with {
    requires: value >= 0n;
    ensures: result === value + 1n;
  }: bigint { return value + 1n; }
  successor(-1n);`;
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: ["logic.tspp", "program.tspp"],
    sourceFiles: [
      { fileName: "logic.tspp", text: library },
      { fileName: "program.tspp", text: program },
    ],
  });
  assert.deepEqual(diagnostics.map(diagnostic => `${diagnostic.fileName}: ${diagnostic.message.replace(/ Counterexample:[\s\S]*/, "")}`), [
    "program.tspp: successor call precondition could not be proved.",
  ]);
});
