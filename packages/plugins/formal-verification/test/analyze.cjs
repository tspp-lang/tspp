const assert = require("node:assert/strict");
const { usePlugins } = require("../../test-support/compile.cjs");
const { createFormalVerificationAnalyzer, formalVerificationPlugin } = require("../dist");
// nominal-types is an optional dependency; with it, proofs can model `data` declarations.
const { nominalTypesADTAPI, nominalTypesPlugin } = require("../../nominal-types/dist");

// The analyzer parses with the host compiler, so its syntax and the syntax it models must be active there.
usePlugins(formalVerificationPlugin, nominalTypesPlugin);

const formalVerificationAnalyzer = createFormalVerificationAnalyzer({ getNominalTypes: () => nominalTypesADTAPI });

/** Analyzes one source file and returns its diagnostic messages. */
async function analyzeSource(text, fileName = "case.tspp") {
  const diagnostics = await formalVerificationAnalyzer.analyze({
    currentDirectory: process.cwd(), rootFileNames: [fileName],
    sourceFiles: [{ fileName, text }],
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
