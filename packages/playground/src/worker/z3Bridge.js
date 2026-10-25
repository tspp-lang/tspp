/**
 * Browser Z3 bridge for the tspp language worker.
 *
 * Spawns the vendored classic worker (public/vendor/z3.worker.js — see
 * scripts/build-z3-worker.mjs) that owns the z3-solver WASM module, and
 * runs batches of standard SMT-LIB requests over postMessage. The language worker
 * itself is an ES-module worker and the compiler bundle is runtime-fetched;
 * Z3 needs its own pthread-capable classic worker, so the two never mix.
 *
 * Everything is lazy: the worker and the 35 MB wasm are only fetched when the
 * first verification batch actually needs solving (the compiler otherwise
 * returns "Z3 is unavailable in this runtime." artifacts on its own).
 *
 * Cross-origin isolation (coi-serviceworker, booted from index.html) makes
 * SharedArrayBuffer available on GitHub Pages so Z3's pthread workers work.
 */

/** @type {Promise<Worker> | undefined} */
let workerReady;
/** @type {Worker | undefined} the live worker behind workerReady */
let activeWorker;
/** @type {Map<number, {resolve: (results: unknown[]) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
const pendingQueries = new Map();
let nextQueryId = 1;
/** Serializes batches: Z3's high-level API queues internally, but a chain here
 *  keeps the wasm warm-up from racing with an in-flight batch. */
let batchChain = Promise.resolve();
/** Deduplicates concurrent identical batches: the Verify sidebar polls while
 *  artifacts are unresolved, and every poll would otherwise queue a fresh
 *  solve of the same inputs behind the still-running first one. */
const inFlightBatches = new Map();

const QUERY_TIMEOUT_MS = 120_000;

/** Terminates the live worker so the next batch spawns a fresh module. Needed
 *  because some Z3 failures (e.g. a pthread spawn error mid-check) leave the
 *  module's async-call mutex permanently locked: every later check() on the
 *  same instance throws "you can't execute multiple async functions", while a
 *  fresh worker solves cleanly. */
function recycleZ3Worker(reason) {
  if (activeWorker) {
    try { activeWorker.terminate(); } catch { /* already gone */ }
    activeWorker = undefined;
  }
  workerReady = undefined;
  console.warn(`[z3 bridge] recycled the z3 worker: ${reason}`);
}

/**
 * Resolves a vendored asset (z3.worker.js, z3-built.wasm) against the site's
 * base. Root-absolute paths would 404 on GitHub Pages project subpaths — this
 * module runs inside the language worker, whose own URL is
 * <base>/assets/<chunk>.js when built, so "../vendor/" lands on <base>/vendor/.
 * In vite dev the worker is served from /src/worker/ while public/ files sit at
 * the origin root. Outside a browser (Node spike) nothing resolves and the
 * caller's catch keeps the compiler's artifacts, as designed.
 * @param {string} fileName
 */
function vendorUrl(fileName) {
  const here = typeof self !== "undefined" ? self.location?.href : undefined;
  if (typeof here === "string" && here.startsWith("http")) {
    const relative = here.includes("/src/worker/") ? `/vendor/${fileName}` : `../vendor/${fileName}`;
    return new URL(relative, here).href;
  }
  return new URL(`/vendor/${fileName}`, self?.location?.origin ?? "http://localhost").href;
}

async function spawnZ3Worker() {
  const workerUrl = vendorUrl("z3.worker.js");
  const wasmUrl = vendorUrl("z3-built.wasm");
  const response = await fetch(workerUrl);
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${workerUrl}`);
  const blobUrl = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
  const worker = new Worker(blobUrl);
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("z3 worker did not become ready in time")), QUERY_TIMEOUT_MS);
    worker.onmessage = event => {
      const data = event?.data;
      if (data?.kind === "ready") {
        clearTimeout(timer);
        resolve();
      } else if (data?.kind === "init-error") {
        clearTimeout(timer);
        reject(new Error(`z3 init failed: ${data.error}`));
      } else if (typeof data?.id === "number") {
        const pending = pendingQueries.get(data.id);
        if (pending) {
          pendingQueries.delete(data.id);
          clearTimeout(pending.timer);
          if (data.ok) pending.resolve(data.responses);
          else pending.reject(new Error(data.error ?? "z3 worker query failed"));
        }
      }
    };
    worker.onerror = event => {
      clearTimeout(timer);
      reject(new Error(`z3 worker error: ${event?.message ?? "unknown"}`));
    };
  });
    worker.postMessage({ z3WasmUrl: wasmUrl, workerUrl });
  await ready;
  activeWorker = worker;
  return worker;
}

function ensureZ3Worker() {
  if (!workerReady) {
    workerReady = spawnZ3Worker().catch(error => {
      workerReady = undefined; // allow a later retry after a transient failure
      throw error;
    });
  }
  return workerReady;
}

/**
 * Runs a batch of SMT-LIB requests (the compiler's VerificationSolverRequest:
 * script, timeoutMs and follow-up commands) through the z3 worker. The
 * returned array holds raw VerificationSolverResponse values (status and
 * follow-up output) in input order; the compiler interprets them, so its own
 * result pipeline (caching, reasons, artifacts, diagnostics) is shared with
 * the Node backend. Identical concurrent batches share one run (the Verify
 * sidebar polls while solving).
 * @param {readonly { script: string, timeoutMs: number, onSat?: string, onUnsat?: string, onUnknown?: string }[]} requests
 * @param {{ isCancellationRequested?: () => boolean } | undefined} cancellationToken
 */
export async function solveBatch(requests, cancellationToken) {
  const key = JSON.stringify(requests);
  const inFlight = inFlightBatches.get(key);
  if (inFlight) return inFlight;

  const task = async () => {
    if (cancellationToken?.isCancellationRequested?.()) throw new Error("cancelled");
    const worker = await ensureZ3Worker();
    const id = nextQueryId++;
    try {
      const results = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingQueries.delete(id);
          reject(new Error(`z3 query batch timed out after ${QUERY_TIMEOUT_MS}ms`));
        }, QUERY_TIMEOUT_MS);
        pendingQueries.set(id, { resolve, reject, timer });
        worker.postMessage({ id, requests: [...requests] });
      });
      // Per-query "error" entries mean a Z3 exception (bad worker URL, pthread
      // spawn failure, poisoned async mutex). The module may be unusable —
      // recycle so the next batch starts fresh.
      if (results.some(r => r?.status === "error")) recycleZ3Worker("query returned an error result");
      return results;
    } catch (error) {
      recycleZ3Worker("query batch failed");
      throw error;
    }
  };
  const run = batchChain.then(task, task);
  // Keep the chain alive regardless of this batch's outcome.
  batchChain = run.then(() => undefined, () => undefined);
  inFlightBatches.set(key, run);
  run.finally(() => inFlightBatches.delete(key)).catch(() => {});
  return run;
}
