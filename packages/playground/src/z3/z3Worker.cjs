if (typeof global === "undefined") globalThis.global = globalThis;

const initZ3Module = require("./z3-built.js");
globalThis.initZ3 = initZ3Module;
const isPthread = String(self.name || "").startsWith("em-pthread");

if (!isPthread) {
  const { init } = require("./browser.js");
  let api;

  const initApi = (wasmUrl, script) => api ??= (async () => {
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

  async function evaluate(em, context, text) {
    const bytes = new TextEncoder().encode(text);
    const pointer = em._malloc(bytes.length + 1);
    em.HEAPU8.set(bytes, pointer);
    em.HEAPU8[pointer + bytes.length] = 0;
    try { return await em.async_call(em._async_Z3_eval_smtlib2_string, context, pointer); }
    finally { em._free(pointer); }
  }

  async function runQueries(queries) {
    const { Z3, em } = await api;
    const config = Z3.mk_config();
    const answers = [];
    try {
      for (const query of queries) {
        const context = Z3.mk_context(config);
        const run = text => evaluate(em, context, text);
        try {
          const loaded = await run(`(set-option :timeout 10000)\n${query.programSemantics}\n${query.script || ""}\n(assert (not ${query.goal}))`);
          const error = loaded.match(/\(error [^\n]*/);
          if (error) answers.push({ status: "error", message: error[0] });
          else {
            const status = (await run("(check-sat)")).trim();
            answers.push(status === "sat"
              ? { status, output: await run("(get-model)") }
              : status === "unsat" || status === "unknown"
                ? { status }
                : { status: "error", message: status || "check-sat produced no answer" });
          }
        }
        catch (error) { answers.push({ status: "error", message: error?.message ?? String(error) }); }
        finally { Z3.del_context(context); }
      }
    }
    finally { Z3.del_config(config); }
    return answers;
  }

  self.onmessage = async ({ data }) => {
    if (typeof data?.wasmUrl === "string") {
      try {
        await initApi(data.wasmUrl, data.script);
        self.postMessage({ kind: "ready" });
      }
      catch (error) { self.postMessage({ kind: "init-error", error: String(error?.message ?? error) }); }
      return;
    }
    if (typeof data?.id !== "number" || !Array.isArray(data.queries)) return;
    try {
      const queries = data.queries.map(query => ({ ...query, programSemantics: data.programSemantics }));
      self.postMessage({ id: data.id, ok: true, answers: await runQueries(queries) });
    }
    catch (error) { self.postMessage({ id: data.id, ok: false, error: String(error?.message ?? error) }); }
  };
}
