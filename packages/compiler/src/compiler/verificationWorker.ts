import {
  analysisReasonForVerificationStatus,
  defaultAnalysisWorkerBudget,
} from "./analysisTasks.js";
import { scheduleAnalysisWorker } from "./analysisWorkerQueue.js";
import { isNodeLikeSystem } from "./core.js";
import {
  AnalysisTaskReason,
  CancellationToken,
  CompilerHost,
  VerificationStatus,
} from "./types.js";
import { VerificationQueryCache } from "./verificationIncremental.js";
import type { VerificationQuery } from "./verificationSmt.js";
import {
  getVerificationFollowUps,
  interpretVerificationResponse,
} from "./verificationSmtResponse.js";

/** @internal */
export interface VerificationSolverResult {
  readonly status: VerificationStatus;
  readonly message: string;
  readonly counterexample?: string;
  readonly model?: string;
  readonly reason?: AnalysisTaskReason;
  /** Trusted inputs a proved obligation depends on. */
  readonly trustedInputs?: readonly string[];
}

/**
 * One standard SMT-LIB query for a solver backend. The backend loads
 * `script` into a fresh solver state, runs `(check-sat)`, then runs the
 * follow-up command that matches the answer and returns its raw output.
 * `timeoutMs` is the per-query budget; how a backend enforces it (an option,
 * a flag, killing a process) is backend-specific and never part of `script`.
 *
 * @internal
 */
export interface VerificationSolverRequest {
  readonly script: string;
  readonly timeoutMs: number;
  readonly onSat?: string;
  readonly onUnsat?: string;
  readonly onUnknown?: string;
}

/** The raw answer of a solver backend to one request. @internal */
export interface VerificationSolverResponse {
  readonly status: "sat" | "unsat" | "unknown" | "error";
  /** Output of the follow-up command, verbatim. */
  readonly output?: string;
  /** Error text, for status "error". */
  readonly message?: string;
}

/** @internal */
export interface VerificationCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

/** @internal */
export interface VerificationWorkerBudget {
  readonly minimumTimeoutMs: number;
  readonly timeoutPerQueryMs: number;
  readonly maxOldGenerationSizeMb: number;
}

const defaultVerificationWorkerBudget: VerificationWorkerBudget = {
  minimumTimeoutMs: 30_000,
  timeoutPerQueryMs: 12_000,
  maxOldGenerationSizeMb: defaultAnalysisWorkerBudget.maxOldGenerationSizeMb,
};

/** The solver's own per-query limit; the worker budget above is the wall-clock backstop. */
const solverTimeoutMs = 10_000;

const maximumCachedVerificationQueries = 2048;
const verificationResultCache = new VerificationQueryCache<VerificationSolverResult>(maximumCachedVerificationQueries);

function createVerificationSolverRequest(query: VerificationQuery): VerificationSolverRequest {
  return { script: query.script, timeoutMs: solverTimeoutMs, ...getVerificationFollowUps(query) };
}

/** @internal */
export async function runVerificationQueries(
  queries: readonly VerificationQuery[],
  budget: VerificationWorkerBudget = defaultVerificationWorkerBudget,
  cancellationToken?: CancellationToken,
  host?: CompilerHost,
): Promise<readonly VerificationSolverResult[]> {
  cancellationToken?.throwIfCancellationRequested();
  const results: (VerificationSolverResult | undefined)[] = new Array(queries.length);
  const missingQueries: VerificationQuery[] = [];
  const missingIndexes = new Map<string, number[]>();
  for (let index = 0; index < queries.length; index++) {
    const query = queries[index];
    // The script is the dependency key: it contains every declaration,
    // definition, assertion, and source mapping the answer depends on.
    const cached = verificationResultCache.get(query.script);
    if (cached) {
      results[index] = cached;
      continue;
    }
    let indexes = missingIndexes.get(query.script);
    if (!indexes) {
      verificationResultCache.recordMiss();
      missingQueries.push(query);
      missingIndexes.set(query.script, indexes = []);
    }
    indexes.push(index);
  }
  if (missingQueries.length) {
    const requests = missingQueries.map(createVerificationSolverRequest);
    // Host-supplied solver first (a browser language worker injects its own
    // backend); fall back to the node:worker_threads Z3 backend. Both answer
    // with raw SMT-LIB responses that are interpreted here.
    const missingResults = host?.solveVerificationQueries
      ? await withHostSolverBudget(host.solveVerificationQueries(requests, cancellationToken), missingQueries, budget)
      : await scheduleAnalysisWorker(
        "compiler-analysis",
        () => runVerificationQueriesWorker(missingQueries, requests, budget, cancellationToken),
        cancellationToken,
      );
    for (let index = 0; index < missingQueries.length; index++) {
      const script = missingQueries[index].script;
      const result = missingResults[index];
      if (result.status === "proved" || result.status === "failed") cacheVerificationResult(script, result);
      for (const resultIndex of missingIndexes.get(script)!) results[resultIndex] = result;
    }
  }
  return results as VerificationSolverResult[];
}

function interpretResponses(queries: readonly VerificationQuery[], responses: readonly VerificationSolverResponse[]): readonly VerificationSolverResult[] {
  return queries.map((query, index) => withStructuredReason(interpretVerificationResponse(query, responses[index])));
}

/** Guards a host solver against hanging forever: the host's solver (for
 *  example the playground's browser worker) may be slow to warm up or
 *  wedged, and the compiler's own budget should still apply. Timed-out
 *  queries become the same "unknown: timeout" results the Node path
 *  produces; rejections become the same "unknown: unavailable" results, so
 *  callers never see a throw. */
function withHostSolverBudget(
  solving: Promise<readonly VerificationSolverResponse[]>,
  queries: readonly VerificationQuery[],
  budget: VerificationWorkerBudget,
): Promise<readonly VerificationSolverResult[]> {
  const inputCount = queries.length;
  return new Promise<readonly VerificationSolverResult[]>(resolve => {
    const timer = globalThis.setTimeout(() => {
      resolve(Array.from({ length: inputCount }, () => timedOutResult("The SMT solver timed out.")));
    }, Math.max(budget.minimumTimeoutMs, inputCount * budget.timeoutPerQueryMs));
    solving.then(
      responses => {
        globalThis.clearTimeout(timer);
        resolve(interpretResponses(queries, responses));
      },
      error => {
        globalThis.clearTimeout(timer);
        const message = error instanceof Error ? error.message : String(error);
        resolve(Array.from({ length: inputCount }, () => unavailableResult(`The SMT solver could not run: ${message}`)));
      },
    );
  });
}

/** @internal */
export function getVerificationCacheStats(): VerificationCacheStats {
  return verificationResultCache.stats();
}

/** @internal */
export function clearVerificationCache(): void {
  verificationResultCache.clear();
}

function cacheVerificationResult(script: string, result: VerificationSolverResult): void {
  verificationResultCache.set(script, result);
}

async function runVerificationQueriesWorker(
  queries: readonly VerificationQuery[],
  requests: readonly VerificationSolverRequest[],
  budget: VerificationWorkerBudget,
  cancellationToken: CancellationToken | undefined,
): Promise<readonly VerificationSolverResult[]> {
  try {
    // `typeof require !== "function"` is unreliable in the esbuild browser bundle:
    // bare `require` becomes a Proxy-based shim whose typeof is still "function",
    // so the require("node:worker_threads") below would throw a confusing
    // "Dynamic require of ..." error instead of the clean unavailable result.
    if (!isNodeLikeSystem()) return requests.map(() => unavailableResult("No SMT solver is available in this runtime."));
    const { Worker } = require("node:worker_threads") as typeof import("node:worker_threads");
    const z3Path = require.resolve("z3-solver");
    return await new Promise<readonly VerificationSolverResult[]>((resolve, reject) => {
      let settled = false;
      const worker = new Worker(z3WorkerScript, {
        eval: true,
        workerData: { requests, z3Path },
        resourceLimits: { maxOldGenerationSizeMb: budget.maxOldGenerationSizeMb },
      });
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        if (cancellationPoll) globalThis.clearInterval(cancellationPoll);
        void worker.terminate();
        resolve(requests.map(() => timedOutResult("The SMT solver worker timed out.")));
      }, Math.max(budget.minimumTimeoutMs, requests.length * budget.timeoutPerQueryMs));
      const cancellationPoll = cancellationToken && globalThis.setInterval(() => {
        if (settled || !cancellationToken.isCancellationRequested()) return;
        settled = true;
        globalThis.clearTimeout(timer);
        globalThis.clearInterval(cancellationPoll);
        void worker.terminate();
        resolve(requests.map(() => cancelledResult("Verification was cancelled.")));
      }, 25);
      worker.once("message", (message: { ok: boolean; responses?: VerificationSolverResponse[]; error?: string; }) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (cancellationPoll) globalThis.clearInterval(cancellationPoll);
        void worker.terminate();
        if (message.ok && message.responses) resolve(interpretResponses(queries, message.responses));
        else reject(new Error(message.error ?? "The SMT solver worker failed."));
      });
      worker.once("error", error => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        if (cancellationPoll) globalThis.clearInterval(cancellationPoll);
        void worker.terminate();
        reject(error);
      });
    });
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return requests.map(() => unavailableResult(`The SMT solver could not run: ${message}`));
  }
}

function timedOutResult(message: string): VerificationSolverResult {
  return { status: "unknown", message, reason: { code: "timeout", message } };
}

function cancelledResult(message: string): VerificationSolverResult {
  return { status: "unknown", message, reason: { code: "cancelled", message } };
}

function unavailableResult(message: string): VerificationSolverResult {
  return { status: "unknown", message, reason: { code: "unavailable", message } };
}

function withStructuredReason(result: VerificationSolverResult): VerificationSolverResult {
  return { ...result, reason: result.reason ?? analysisReasonForVerificationStatus(result.status, result.message) };
}

/**
 * The Z3 backend: it only executes standard SMT-LIB text through Z3's
 * SMT-LIB front end. The timeout option is the one Z3-specific command, and
 * it lives here, outside the generated script.
 */
const z3WorkerScript = String.raw`
const { parentPort, workerData } = require("node:worker_threads");

async function run() {
  const z3 = require(workerData.z3Path);
  const { Z3 } = await z3.init();
  const config = Z3.mk_config();
  const responses = [];
  for (const request of workerData.requests) {
    // A fresh context per query: Z3's (reset) keeps define-fun-rec definitions.
    const context = Z3.mk_context(config);
    const evaluate = text => Z3.eval_smtlib2_string(context, text);
    try {
      const loaded = await evaluate("(set-option :timeout " + request.timeoutMs + ")\n" + request.script);
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
      responses.push({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
    finally {
      Z3.del_context(context);
    }
  }
  return responses;
}

run().then(
  responses => parentPort.postMessage({ ok: true, responses }),
  error => parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }),
);
`;
