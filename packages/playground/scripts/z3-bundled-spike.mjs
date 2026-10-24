/**
 * Spike: verify the bundled public/vendor/z3.worker.js behaves like a classic
 * worker inside a minimal worker-global simulation. Steps:
 *   1. evaluate the bundle text in a Function scope with worker-ish globals
 *      (self -> a stub with onmessage/postMessage/ location, no process)
 *   2. post { z3WasmUrl } (converted to a file:// URL that the shim's fetch maps
 *      to a real read) and await { kind: "ready" }
 *   3. post { id, requests } shaped like the tspp worker will send (standard
 *      SMT-LIB scripts plus follow-up commands), and await the raw responses
 *
 * Run with: node scripts/z3-bundled-spike.mjs
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const wasmPath = resolve(root, "..", "..", "node_modules", "z3-solver", "build", "z3-built.wasm");
const wasmUrl = pathToFileURL(wasmPath).href;
const bundlePath = resolve(root, "public", "vendor", "z3.worker.js");
const bundleText = readFileSync(bundlePath, "utf8");

const results = [];
function check(name, ok, detail = "") {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

// ---- minimal classic-worker global simulation --------------------------------
let workerOnMessage = null;
const posted = [];
const simulatedWorker = {
  set onmessage(handler) {
    workerOnMessage = handler;
  },
  get onmessage() {
    return workerOnMessage;
  },
  postMessage(data) {
    posted.push(data);
  },
  // classic workers expose self.location (script URL)
  location: { href: "" },
};
simulatedWorker.location.href = wasmUrl;
const fetchShim = async url => {
  if (url === wasmUrl) {
    const bytes = readFileSync(wasmPath);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  }
  return { ok: false, status: 404 };
};

const scope = {
  self: simulatedWorker,
  fetch: fetchShim,
  WebAssembly,
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob: class {},
  // emscripten's ENVIRONMENT_IS_WORKER check — a real classic worker has this.
  WorkerGlobalScope: class WorkerGlobalScope {},
};
scope.globalThis = scope;
// Node has a real `global` alias pointing at the true globalThis; a web worker
// does not. Shadow it with the simulated scope so the bundle's
// `globalThis.global = globalThis` polyfill and browser.js's `global.initZ3`
// read land inside this scope, exactly as they would in a worker.
scope.global = scope;

// Shadow Node's own `process` (a web worker has none) so z3-built's emscripten
// glue takes the web branch instead of the Node fs/__dirname branch, and pass
// a WorkerGlobalScope marker (scope properties are NOT in the Function's scope
// chain — only parameters are) so ENVIRONMENT_IS_WORKER is true. `Worker` is a
// stub whose spawn reports an error, mirroring a browser without
// SharedArrayBuffer (no COOP/COEP): pthread_create then fails and Z3 must run
// the query on the calling thread or reject — this spike pins down which.
const run = new Function("self", "fetch", "WebAssembly", "console", "setTimeout", "clearTimeout", "URL", "globalThis", "global", "process", "WorkerGlobalScope", "location", "Worker", "SharedArrayBuffer", bundleText);
run(simulatedWorker, fetchShim, WebAssembly, console, setTimeout, clearTimeout, URL, scope, scope.global, undefined, scope.WorkerGlobalScope, simulatedWorker.location, class Worker {
  constructor() {
    setTimeout(() => this.onerror?.({ message: "workers unavailable (simulated no-SAB browser)", lineno: 0, filename: "" }), 0);
  }
  postMessage() {}
  terminate() {}
}, undefined);
void SharedArrayBuffer; // deliberately absent from the simulated worker global
check("bundle evaluated and installed onmessage", typeof workerOnMessage === "function", String(typeof workerOnMessage));
console.error(`[z3-spike] scope.global?.initZ3 = ${typeof scope.global?.initZ3}; scope.initZ3 = ${typeof scope.initZ3}`);

// wait for the async init flow: post the wasm URL, then poll `posted`
simulatedWorker.postMessage = data => posted.push(data);
workerOnMessage({ data: { z3WasmUrl: wasmUrl } });

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  console.error(`timeout waiting for ${label}`);
  return false;
}

const ready = await waitFor(() => posted.some(m => m?.kind === "ready" || m?.kind === "init-error"), 90_000, "z3 init");
const initMessage = posted.find(m => m?.kind === "ready" || m?.kind === "init-error");
check("z3 init inside bundled worker", ready && initMessage?.kind === "ready", initMessage ? JSON.stringify(initMessage).slice(0, 120) : "no message");

if (initMessage?.kind === "ready") {
  posted.length = 0;
  const queryId = 7;
  workerOnMessage({ data: { id: queryId, requests: [{ script: "(set-logic QF_LIA)\n(declare-const x Int)\n(assert (> x 3))\n", timeoutMs: 10_000, onSat: "(get-value (x))" }] } });
  const replied = await waitFor(() => posted.some(m => m?.id === queryId), 90_000, "query reply");
  const reply = posted.find(m => m?.id === queryId);
  // This simulation has NO SharedArrayBuffer (Node's web-worker globals are
  // stubbed), so check() cannot spawn pthread workers here. What this pin
  // verifies is the round-trip protocol: the request reaches runRequests, Z3
  // reports the threading limitation through the error channel, and a
  // well-formed reply comes back. End-to-end sat/unsat proving happens in a
  // real cross-origin-isolated browser (coi-serviceworker boots it).
  const checkFailedResult = reply?.responses?.[0];
  const threadingError = checkFailedResult?.status === "error"
    && /thread|SharedArrayBuffer|pthread|worker/i.test(String(checkFailedResult.message));
  check(
    "bundled worker round-trips a query (no-SAB env reports the threading limit)",
    replied && reply?.ok === true && Array.isArray(reply.responses) && threadingError,
    reply ? JSON.stringify(reply).slice(0, 140) : "no reply",
  );
}

const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
