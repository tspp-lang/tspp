// Formal verification owns `with { ... }` after a function's parameters; macros configure themselves in
// `macro({ ... })` before `function`. With both plugins enabled, each sees only its own syntax (tspp-lang/tspp#34).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const options = { noLib: false, lib: ["lib.es2022.d.ts"], noImplicitAny: false };

test("macro options and contract clauses each reach their own plugin", async () => {
  const source = `
export macro({ timeout: { type: "bogus" } }) function expose(targets: any, context: any) { return []; }
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
    `The 'timeout' option must match '{ type: "fixed"; value: number; unit: "ms" | "s"; } | { type: "benchmark"; multiplier: number; }'.`,
  ]);
  const analysis = await ts.runTSPPProgramAnalyzers(program);
  assert.deepEqual(analysis.map(diagnostic => diagnostic.message), []);
});

test("a contract clause on a macro function belongs to verification, not to the macro", async () => {
  const source = `
export macro function expose(targets: any, context: any) with { timeout: 1; } { return []; }
`;
  const { program } = createProgram({ "/main.tspp": source }, options);
  assert.deepEqual(diagnosticMessages(program), []);
  const analysis = await ts.runTSPPProgramAnalyzers(program);
  assert.deepEqual(analysis.map(diagnostic => diagnostic.message), ["The 'with' property 'timeout' is not supported on a function."]);
});
