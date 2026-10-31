import { Worker } from "node:worker_threads";

export interface Z3Query {
    readonly expression: string;
}

export interface Z3Answer {
    readonly status: "sat" | "unsat" | "unknown" | "error";
    readonly output?: string;
    readonly message?: string;
}

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
async function main() {
  const z3 = require(workerData.z3Path);
  const { Z3 } = await z3.init();
  const config = Z3.mk_config();
  const answers = [];
  try {
    for (const query of workerData.queries) {
      const context = Z3.mk_context(config);
      const evaluate = text => Z3.eval_smtlib2_string(context, text);
      try {
        const loaded = await evaluate("(set-option :timeout 10000)\n(assert (not " + query.expression + "))");
        const error = loaded.match(/\(error [^\n]*/);
        if (error) answers.push({ status: "error", message: error[0] });
        else {
          const status = (await evaluate("(check-sat)")).trim();
          answers.push(status === "sat"
            ? { status, output: await evaluate("(get-model)") }
            : status === "unsat" || status === "unknown"
              ? { status }
              : { status: "error", message: status || "check-sat produced no answer" });
        }
      } catch (error) {
        answers.push({ status: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        Z3.del_context(context);
      }
    }
  } finally {
    Z3.del_config(config);
  }
  return answers;
}
main().then(
  answers => parentPort.postMessage({ ok: true, answers }),
  error => parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }),
);
`;

export function solveWithZ3(queries: readonly Z3Query[]): Promise<readonly Z3Answer[]> {
    if (!queries.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        const worker = new Worker(workerSource, {
            eval: true,
            workerData: { queries, z3Path: require.resolve("z3-solver") },
            resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        const timer = setTimeout(() => {
            void worker.terminate();
            reject(new Error("The Z3 worker exceeded its 30 second budget."));
        }, 30_000);
        worker.once("message", (message: { ok: boolean; answers?: readonly Z3Answer[]; message?: string; }) => {
            clearTimeout(timer);
            void worker.terminate();
            if (message.ok && message.answers) resolve(message.answers);
            else reject(new Error(message.message ?? "The Z3 worker failed."));
        });
        worker.once("error", error => {
            clearTimeout(timer);
            reject(error);
        });
    });
}
