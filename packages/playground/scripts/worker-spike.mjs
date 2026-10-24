/**
 * Worker-level spike: drive the real TsppWorker class with a mock of monaco's
 * mirror-models worker context (the same host surface the real worker sees) and verify:
 *   1. diagnostics are empty for a data + match program when tsppFeatures includes dataDeclarations
 *   2. getEmitOutput returns the tagged-record runtime JS
 *   3. completions/hover (quickInfo) resolve through the tspp language service
 *   4. flipping tsppFeatures off reproduces the feature-gating error inside the worker host
 *
 * This closes the loop between the compiler bundle and the exact worker host methods
 * monaco calls, without needing a browser.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const nodeProcess = process; // captured before the browser-worker simulation shadows it
// Simulate the browser-worker global shape before any compiler code loads: with
// process.browser set (the conventional browserify marker) the compiler's
// isNodeLikeSystem() returns false and it never touches Node builtins — exactly
// what happens inside a real web worker, where `process` does not exist at all.
globalThis.process = { browser: true };
const { TypeScriptWorker } = await import("monaco-editor/languages/features/typescript/tsWorker.js");
const { TsppWorker } = await import("../src/worker/tsppWorkerClass.js").then(m => ({ TsppWorker: m.TsppWorker }));
void TypeScriptWorker;

const tspp = require("../public/vendor/typescript.js");

const CODE = `data Option<T> = None | Some(value: T);

export function getOrElse(opt: Option<number>, fallback: number): number {
  return match opt {
    None => fallback,
    Some(value) => value,
  };
}
`;

function makeContext(fileName, text) {
  const model = {
    uri: { toString: () => `file:///${fileName}`, path: `/${fileName}` },
    version: 1,
    getValue: () => text,
  };
  return { getMirrorModels: () => [model] };
}

function makeWorker(fileName, text, features) {
  const createData = {
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 99, // ESNext
      allowNonTsExtensions: true,
      tsppFeatures: features,
    },
    extraLibs: Object.create(null),
    inlayHintsOptions: {},
  };
  return new TsppWorker(makeContext(fileName, text), createData, tspp);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

const FILE = "input.tspp";
const URI = `file:///${FILE}`;

// 1-2: data program with the feature enabled
const worker = makeWorker(FILE, CODE, ["dataDeclarations"]);
const semantic = await worker.getSemanticDiagnostics(URI);
const syntactic = await worker.getSyntacticDiagnostics(URI);
const messages = [...syntactic, ...semantic].map(d => `TS${d.code}: ${String(d.messageText).split("\n")[0]}`);
check("worker diagnostics empty with feature on", messages.length === 0, messages.join(" | ") || "clean");

const emit = await worker.getEmitOutput(URI);
const js = emit.outputFiles.find(f => f.name.endsWith(".js"))?.text ?? "";
check("worker emit produces tagged records", js.includes(`_tag: "None"`) && js.includes(`_tag: "Some"`));
check("worker emit produces tag-discriminated match", js.includes(`_tag === "Some"`));

// 3: hover through the tspp language service
const quickInfo = await worker.getQuickInfoAtPosition(URI, CODE.indexOf("getOrElse"));
check("quickInfo resolves exported function", !!quickInfo, quickInfo?.displayParts?.map(p => p.text).join("") || "none");
const completions = await worker.getCompletionsAtPosition(URI, CODE.indexOf("None =>") + 2);
check("completions available", !!completions && completions.entries.length > 0, completions ? `${completions.entries.length} entries` : "none");

// 4: feature off -> the worker's own host reproduces the gating error on a .ts twin
const offWorker = makeWorker("input.ts", CODE, undefined);
const offDiags = await offWorker.getSemanticDiagnostics("file:///input.ts");
const offMessages = offDiags.map(d => `TS${d.code}`);
check(
  "worker reports feature-gating error with feature off",
  offMessages.some(code => code === "TS18072" || code === "TS2552" || code === "TS2304"),
  offDiags.slice(0, 2).map(d => `TS${d.code}: ${String(d.messageText).split("\n")[0]}`).join(" | "),
);

// 5-7: formal verification through the host-solver seam.
// setCompilerHost (called by the services layer on the first program sync) wires
// z3Bridge.solveBatch into the compiler. In this Node spike the browser bridge
// cannot spawn its worker, so we replace the seam with a scripted mock solver at
// the exact point the real worker would hand it over — exercising the compiler
// end to end (schedule → solve → attach → artifacts → diagnostics), which is the
// entire production path minus the network layer covered by z3-load/z3-bundled.
const CONTRACTS = `function pos(n: bigint) with {
  requires: n >= 0n;
  ensures: result === n;
}: bigint {
  return n;
}
const ok: bigint = pos(5n);
`;
const PLACEHOLDER = "Formal verification is running asynchronously.";

// Mocks answer the compiler's raw SMT-LIB protocol (VerificationSolverResponse);
// the compiler itself turns them into proved/failed/unknown artifacts.
let mockSolve = () => ({ status: "error", message: "no mock installed" });
let debugSolverCalls = [];
const capturedHosts = [];
const originalSetCompilerHost = TsppWorker.prototype.setCompilerHost;
TsppWorker.prototype.setCompilerHost = function (compilerHost) {
  originalSetCompilerHost.call(this, compilerHost);
  // Swap the bridge for the mock before the first program build schedules its solve.
  compilerHost.solveVerificationQueries = async requests => {
    debugSolverCalls.push(requests.length);
    return requests.map(request => mockSolve(request));
  };
  capturedHosts.push(compilerHost);
};

function makeSolvedWorker(text, solve) {
  mockSolve = solve;
  debugSolverCalls = [];
  return makeWorker(FILE, text, ["formalContracts"]);
}

// Distinct obligations per scenario: the compiler's verification result cache is
// keyed by the generated SMT-LIB text, so identical queries in later workers
// would return the first scenario's cached outcome — vary the contract itself.
const contractsNamed = name => `function ${name}(n: bigint) with {
  requires: n >= 0n;
  ensures: result === n;
}: bigint {
  return n;
}
const ok: bigint = ${name}(5n);
`;
const CONTRACTS_VARIANT = `function pos(n: bigint) with {
  requires: n >= 0n;
  ensures: result === n + 1n;
}: bigint {
  return n;
}
const ok: bigint = pos(5n);
`;

async function settleArtifacts(worker) {
  let artifacts = await worker.getVerificationArtifacts();
  for (let attempt = 0; attempt < 40 && artifacts.some(a => a.message === PLACEHOLDER); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 150));
    artifacts = await worker.getVerificationArtifacts();
  }
  return artifacts;
}

const vWorker = makeSolvedWorker(CONTRACTS, () => ({ status: "unsat" }));
const vArtifacts = await settleArtifacts(vWorker);
check("verification artifacts include call-site precondition", vArtifacts.length === 2, `${vArtifacts.length} artifacts: ${vArtifacts.map(a => a.obligation).join(", ")}`);
check(
  "artifacts settle proved through the host seam",
  vArtifacts.every(a => a.status === "proved" && a.message.includes("solver proved")),
  vArtifacts.map(a => `${a.obligation}:${a.status}`).join(", "),
);
check(
  "artifacts carry replayable SMT-LIB",
  vArtifacts.every(a => typeof a.replayableSmtLib === "string" && a.replayableSmtLib.includes("(check-sat)")),
  vArtifacts.map(a => a.replayableSmtLib.split("\n")[0]).join(" | ").slice(0, 80),
);

// 8: no artifacts without the feature.
const noWorker = makeWorker(FILE, CODE, ["dataDeclarations"]);
const noArtifacts = await noWorker.getVerificationArtifacts();
check("no artifacts without the feature", noArtifacts.length === 0, `${noArtifacts.length} artifacts`);

// 9: the compiler's 18090 diagnostics reflect the Z3 outcomes natively —
// proved removes the diagnostic, failed reports the counterexample — with no
// worker-side rewriting anywhere in the pipeline.
const diagsProved = (await vWorker.getSemanticDiagnostics(URI)).filter(d => d.code === 18090);
check(
  "proved outcomes emit no 18090 diagnostics",
  diagsProved.length === 0,
  `${diagsProved.length} remain: ${diagsProved.map(d => String(d.messageText).slice(0, 40)).join(" | ") || "clean"}`,
);
// Answers the request's own `(get-value (...))` follow-up with -1 for every symbol.
const fWorker = makeSolvedWorker(CONTRACTS_VARIANT, request => {
  const symbols = request.onSat?.match(/^\(get-value \((.*)\)\)$/)?.[1].split(" ") ?? [];
  return { status: "sat", output: `(${symbols.map(symbol => `(${symbol} (- 1))`).join(" ")})` };
});
const fArtifacts = await settleArtifacts(fWorker);
// The shared precondition query may legitimately hit the compiler's result
// cache (identical SMT-LIB across scenarios) — what matters is that the new
// query settles failed with the mock's counterexample.
const fFailed = fArtifacts.filter(a => a.status === "failed" && a.counterexample === "n = -1");
check(
  "failed outcomes settle with counterexample",
  fFailed.length >= 1 && fArtifacts.every(a => ["proved", "failed"].includes(a.status)),
  fArtifacts.map(a => `${a.obligation}:${a.status}${a.counterexample ? ` (${a.counterexample})` : ""}`).join(", "),
);
const diagsFailed = (await fWorker.getSemanticDiagnostics(URI)).filter(d => d.code === 18090);
check(
  "failed outcomes emit counterexample diagnostics",
  diagsFailed.length === fArtifacts.length - fFailed.length
    && diagsFailed.every(d => String(d.messageText).includes("proof failed") && String(d.messageText).includes("n = -1")),
  `${diagsFailed.length} diagnostics: ${diagsFailed.map(d => String(d.messageText).slice(0, 60)).join(" | ")}`,
);

// 10: an unavailable solver (the bridge fails, e.g. no cross-origin isolation)
// degrades to the compiler's unknown/unavailable artifacts and diagnostics —
// the pre-seam behavior, now routed through the compiler itself.
const CONTRACTS_VARIANT2 = `function pos(n: bigint) with {
  requires: n >= 0n;
  ensures: result === n + 2n;
}: bigint {
  return n;
}
const ok: bigint = pos(5n);
`;
const uWorker = makeSolvedWorker(CONTRACTS_VARIANT2, () => {
  throw new Error("z3 worker did not become ready in time");
});
const uArtifacts = await settleArtifacts(uWorker);
const uUnknown = uArtifacts.filter(a => a.status === "unknown" && a.reason?.code === "unavailable");
check(
  "unavailable solver degrades to unknown artifacts",
  uUnknown.length >= 1 && uArtifacts.every(a => ["proved", "unknown"].includes(a.status)),
  uArtifacts.map(a => `${a.obligation}:${a.status}/${a.reason?.code}`).join(", "),
);
const diagsUnavailable = (await uWorker.getSemanticDiagnostics(URI)).filter(d => d.code === 18090);
check(
  "unavailable solver keeps 18090 diagnostics",
  diagsUnavailable.length === uArtifacts.length - uUnknown.length
    && diagsUnavailable.every(d => String(d.messageText).includes("verification unknown")),
  `${diagsUnavailable.length} diagnostics: ${diagsUnavailable.map(d => String(d.messageText).slice(0, 50)).join(" | ")}`,
);
TsppWorker.prototype.setCompilerHost = originalSetCompilerHost;

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
nodeProcess.exit(failed ? 1 : 0);
