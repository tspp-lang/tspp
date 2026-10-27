/**
 * The Z3 worker: a classic worker script (bundled by the z3 plugin in vite.config.ts,
 * with z3-solver's build directory as its base) that runs standard SMT-LIB requests.
 * The compiler builds every script and interprets every answer, so this only
 * executes text. Protocol (src/worker/z3Bridge.ts):
 *   -> { wasmUrl, script }         first message: where z3-built.wasm lives, and this script as a Blob
 *   <- { kind: "ready" } | { kind: "init-error", error }
 *   -> { id, requests }            VerificationSolverRequest[]
 *   <- { id, ok, responses | error }
 */

// z3-solver's browser entry reads the Node global "global".
if (typeof global === "undefined") globalThis.global = globalThis;

const initZ3Module = require("./z3-built.js");
globalThis.initZ3 = initZ3Module;

// Z3's pthreads re-run this script as "em-pthread" workers. Requiring z3-built.js
// above already started emscripten's worker bootstrap for them; nothing below may
// run there (the query handler would replace the pthread message handler).
const isPthread = String(self.name || "").startsWith("em-pthread");

if (!isPthread) {
  const { init } = require("./browser.js");
  let api;

  /** Loads the wasm from wasmUrl; pthreads start from `script`, this script's Blob. */
  const initApi = (wasmUrl, script) =>
    api ??= (async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${wasmUrl}`);
      const wasmBytes = new Uint8Array(await response.arrayBuffer());
      return init({
        mainScriptUrlOrBlob: script,
        instantiateWasm(info, receiveInstance) {
          WebAssembly.instantiate(wasmBytes, info).then(
            pair => receiveInstance(pair.instance, pair.module),
            error => self.postMessage({ kind: "init-error", error: String(error?.message ?? error) }),
          );
        },
      });
    })();

  /**
   * Z3.eval_smtlib2_string passes the text through ccall's "string" argument, which
   * lives on the wasm stack only until the call returns, but the async entry point
   * reads it later on a pthread; by then the stack may hold other data and Z3 parses
   * garbage. The text is copied to the heap instead and freed once Z3 has answered.
   */
  async function evalSmtLib2(em, context, text) {
    const bytes = new TextEncoder().encode(text);
    const pointer = em._malloc(bytes.length + 1);
    em.HEAPU8.set(bytes, pointer);
    em.HEAPU8[pointer + bytes.length] = 0;
    try {
      return await em.async_call(em._async_Z3_eval_smtlib2_string, context, pointer);
    }
    finally {
      em._free(pointer);
    }
  }

  async function runRequests(requests) {
    const { Z3, em } = await api;
    const config = Z3.mk_config();
    const responses = [];
    for (const request of requests) {
      // a fresh context per query: (reset) would keep define-fun-rec definitions
      const context = Z3.mk_context(config);
      const evaluate = text => evalSmtLib2(em, context, text);
      try {
        const loaded = await evaluate(`(set-option :timeout ${request.timeoutMs})\n${request.script}`);
        const loadError = loaded.match(/\(error [^\n]*/);
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
        responses.push({ status: "error", message: error?.message ?? String(error) });
      }
      finally {
        Z3.del_context(context);
      }
    }
    return responses;
  }

  self.onmessage = async event => {
    const data = event.data;
    if (typeof data?.wasmUrl === "string") {
      try {
        await initApi(data.wasmUrl, data.script);
        self.postMessage({ kind: "ready" });
      }
      catch (error) {
        self.postMessage({ kind: "init-error", error: String(error?.message ?? error) });
      }
      return;
    }
    if (typeof data?.id !== "number" || !Array.isArray(data.requests)) return;
    try {
      self.postMessage({ id: data.id, ok: true, responses: await runRequests(data.requests) });
    }
    catch (error) {
      self.postMessage({ id: data.id, ok: false, error: String(error?.message ?? error) });
    }
  };
}
