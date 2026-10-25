/**
 * Builds public/vendor/z3.worker.js — a single-file classic-worker script that
 * loads the z3-solver browser build and runs standard SMT-LIB requests over
 * postMessage. It only executes SMT-LIB text; the compiler interprets every
 * answer (counterexamples, unsat cores), so any SMT-LIB 2.6 solver could
 * replace it.
 *
 * Why a separate worker: the tspp language worker is an ES-module worker and the
 * compiler bundle is runtime-fetched; Z3 is a 35 MB wasm + emscripten module that
 * must not block the editor. A classic worker can also spawn Z3's pthread workers
 * from its own blob URL. The main worker talks to it over postMessage:
 *   -> { z3WasmUrl }                        (first message: where z3-built.wasm lives)
 *   -> { id, requests }                     (VerificationSolverRequest[]: script, timeoutMs, follow-ups)
 *   <- { kind: "ready" | "init-error" }
 *   <- { id, ok, responses | error }        (VerificationSolverResponse[]: status, raw output)
 *
 * The wasm binary is fetched at init time from z3WasmUrl and handed to emscripten
 * via moduleOverrides.instantiateWasm (no XHR path, no cross-origin script load).
 *
 * Source: the TS++ compiler package's z3-solver dependency (TSPP_REPO env or
 * packages/compiler), written to public/vendor/z3.worker.js.
 */
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const compilerRoot = process.env.TSPP_REPO ? resolve(process.env.TSPP_REPO) : join(root, "..", "compiler");
const requireFromCompiler = createRequire(join(compilerRoot, "package.json"));
const z3Build = dirname(requireFromCompiler.resolve("z3-solver"));
const vendorDir = join(root, "public", "vendor");
const outfile = join(vendorDir, "z3.worker.js");

if (!existsSync(join(z3Build, "browser.js"))) {
  console.error(`z3-solver not found at ${z3Build} (set TSPP_REPO to the main repo checkout)`);
  process.exit(1);
}

const esbuild = requireFromCompiler("esbuild");

mkdirSync(vendorDir, { recursive: true });
// The wasm binary ships next to the worker; the worker fetches it at init time
// (see instantiateWasm below) instead of emscripten's XHR path.
copyFileSync(join(z3Build, "z3-built.wasm"), join(vendorDir, "z3-built.wasm"));

const entryText = `
// ---- z3 query worker (classic worker script) --------------------------------
// z3-solver's browser entry reads the bare Node global "global"; define it on
// the worker global first (real web workers lack it).
if (typeof global === "undefined") globalThis.global = globalThis;
// The main bridge spawns this script from an object URL, but pthread workers
// must re-enter the REAL same-origin script (emscripten pthreadMainJs comes
// from _scriptName, which is undefined inside a blob worker). The bridge hands
// the real URL over before the wasm init runs.
self.z3WorkerUrl = self.z3WorkerUrl || null;

const initZ3Module = require("./z3-built.js");
globalThis.initZ3 = initZ3Module;

// Pthread reentry: the emscripten module's own tail has already run its worker
// bootstrap for this "em-pthread" worker synchronously above (initZ3 sets
// self.onmessage = handleMessage2 and waits for the main worker's
// {cmd:"load"}). Nothing else from this entry may run here — in particular the
// query onmessage below would overwrite the pthread handler and deadlock the
// pool. Everything after this guard is main-worker-only.
const IS_EM_PTHREAD = typeof WorkerGlobalScope !== "undefined" && String(self.name || "").startsWith("em-pthread");

const browserEntry = IS_EM_PTHREAD ? {} : require("./browser.js");
const init = browserEntry.init;

let apiPromise = null;
let wasmUrl = null;

function initApi() {
  if (apiPromise) return apiPromise;
  apiPromise = (async () => {
    const response = await fetch(wasmUrl);
    if (!response.ok) throw new Error("HTTP " + response.status + " fetching z3-built.wasm");
    const wasmBytes = new Uint8Array(await response.arrayBuffer());
    return init({
      // emscripten derives the pthread entry from Module["mainScriptUrlOrBlob"]
      // (pthreadMainJs = _scriptName would be undefined inside a blob worker,
      // and new Worker(undefined) throws "not a valid URL"). This script runs
      // from an object URL, so the bridge posts the real same-origin script
      // URL and we hand it to emscripten here — pthread mains then re-run this
      // bundle as classic workers, where the "em-pthread" name short-circuits
      // them into emscripten's worker bootstrap before any of this runs.
      mainScriptUrlOrBlob: self.z3WorkerUrl || undefined,
      instantiateWasm(info, receiveInstance) {
        WebAssembly.instantiate(wasmBytes, info).then(
          pair => receiveInstance(pair.instance, pair.module),
          error => { self.postMessage({ kind: "init-error", error: String((error && error.message) || error) }); },
        );
        // undefined return: emscripten waits for receiveInstance.
      },
    });
  })();
  return apiPromise;
}

// Z3's SMT-LIB front end (eval_smtlib2_string): long-running commands run on
// pthread workers spawned from this script's real URL (via the _scriptName
// override in initApi), which requires cross-origin isolation. The playground
// boots coi-serviceworker (see index.html) so SharedArrayBuffer is available
// even on GitHub Pages. The timeout option is the one Z3-specific command; the
// compiler's scripts themselves are standard SMT-LIB.
async function runRequests(requests) {
  const api = await initApi();
  const Z3 = api.Z3;
  const config = Z3.mk_config();
  const responses = [];
  for (const request of requests) {
    // A fresh context per query: Z3's (reset) keeps define-fun-rec definitions.
    const context = Z3.mk_context(config);
    const evaluate = text => Z3.eval_smtlib2_string(context, text);
    try {
      const loaded = await evaluate("(set-option :timeout " + request.timeoutMs + ")\\n" + request.script);
      const loadError = loaded.match(/\\(error [^\\n]*/);
      if (loadError) {
        responses.push({ status: "error", message: loadError[0] });
        continue;
      }
      const answer = (await evaluate("(check-sat)")).trim();
      if (answer !== "sat" && answer !== "unsat" && answer !== "unknown") {
        responses.push({ status: "error", message: answer || "check-sat produced no answer" });
        continue;
      }
      const followUp = answer === "sat" ? request.onSat : answer === "unsat" ? request.onUnsat : request.onUnknown;
      responses.push({ status: answer, output: followUp ? await evaluate(followUp) : undefined });
    }
    catch (error) {
      responses.push({ status: "error", message: (error && error.message) || String(error) });
    }
    finally {
      Z3.del_context(context);
    }
  }
  return responses;
}

if (!IS_EM_PTHREAD) {

self.onmessage = async event => {
  const data = event.data;
  if (data && typeof data === "object" && typeof data.z3WasmUrl === "string") {
    wasmUrl = data.z3WasmUrl;
    if (typeof data.workerUrl === "string") self.z3WorkerUrl = data.workerUrl;
    try {
      await initApi();
      self.postMessage({ kind: "ready" });
    }
    catch (error) {
      self.postMessage({ kind: "init-error", error: String((error && error.message) || error) });
    }
    return;
  }
  if (!data || typeof data.id !== "number" || !Array.isArray(data.requests)) return;
  try {
    const responses = await runRequests(data.requests);
    self.postMessage({ id: data.id, ok: true, responses });
  }
  catch (error) {
    self.postMessage({ id: data.id, ok: false, error: String((error && error.message) || error) });
  }
};

}
`;

await esbuild.build({
  stdin: {
    contents: entryText,
    resolveDir: z3Build,
    sourcefile: "z3-worker-entry.js",
  },
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: false,
  sourcesContent: false,
  legalComments: "none",
  // z3-built.js's Node tail requires these modules, but its own isNode guard
  // (`typeof process.versions.node == "string"`) is dead in a web worker — the
  // require call sits inside `if (isNode)`. Stub the module to keep esbuild happy.
  alias: {
    fs: join(root, "scripts", "empty-worker-threads.js"),
    path: join(root, "scripts", "empty-worker-threads.js"),
    worker_threads: join(root, "scripts", "empty-worker-threads.js"),
  },
  logLevel: "info",
});

const kb = Math.round(statSync(outfile).size / 1024);
const wasmMb = Math.round(statSync(join(vendorDir, "z3-built.wasm")).size / (1024 * 1024));
console.log(`Bundled z3 worker -> public/vendor/z3.worker.js (${kb} KB) + z3-built.wasm (${wasmMb} MB, fetched at runtime)`);
