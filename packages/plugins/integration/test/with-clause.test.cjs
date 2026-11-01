// Macros and formal verification both put a `with { ... }` clause after a function's parameters: macros for their
// timeout, which the compiler checks and applies, and verification for contracts, which its source projection hides
// from the compiler. With both plugins enabled, each clause must still reach its own owner (tspp-lang/tspp#34).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const options = { noLib: false, lib: ["lib.es2022.d.ts"], noImplicitAny: false };

test("a macro's with clause still reaches the compiler next to contract clauses", async () => {
  const source = `
export macro function expose(targets: any, context: any) with { timeout: { type: "bogus" }; } { return []; }
export function clamp(value: bigint) with {
    requires: value >= 0n;
    ensures: result <= 10n;
}: bigint {
    if (value > 10n) return 10n;
    return value;
}
`;
  const { program } = createProgram({ "/main.tspp": source }, options);
  assert.deepEqual(diagnosticMessages(program), [
    `The 'timeout' property must match '{ type: "fixed"; value: number; unit: "ms" | "s"; } | { type: "benchmark"; multiplier: number; }'.`,
  ]);
  const analysis = await ts.runTSPPProgramAnalyzers(program);
  assert.deepEqual(analysis.map(diagnostic => diagnostic.message), []);
});
