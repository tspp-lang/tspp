const assert = require("node:assert/strict");
const { createFormalVerificationAnalyzer } = require("../dist");
// nominal-types is an optional dependency; with it, proofs can model `data` declarations.
const { nominalTypesADTAPI } = require("../../nominal-types/dist");

const formalVerificationAnalyzer = createFormalVerificationAnalyzer({ getNominalTypes: () => nominalTypesADTAPI });

/** Analyzes one source file and returns its diagnostic messages. */
async function analyzeSource(text, fileName = "case.tspp") {
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: [fileName], syntaxKinds: {},
    sourceFiles: [{ fileName, text, root: {} }],
  });
  return diagnostics.map(diagnostic => diagnostic.message);
}

/** A case without `rejects` must verify cleanly; otherwise some diagnostic must match the expected reason. */
async function expectVerification({ source, rejects }) {
  const messages = await analyzeSource(source);
  if (!rejects) return assert.deepEqual(messages, []);
  assert.ok(messages.some(message => rejects.test(message)), `expected ${rejects}, received:\n${messages.join("\n") || "(no diagnostics)"}`);
}

module.exports = { analyzeSource, expectVerification };
