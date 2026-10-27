/**
 * Runs the compiler's SMT-LIB verification queries on Z3 (src/z3/z3Worker.cjs), a
 * nested worker that is only started once the first query arrives. Batches run one
 * at a time; a batch that fails or reports a solver error restarts the worker,
 * since some Z3 failures leave its module unusable.
 */
import type * as ts from "ts-plus-plus/source";

const queryTimeoutMs = 120_000;

export interface Z3Location {
  readonly workerUrl: string;
  readonly wasmUrl: string;
}

export function createZ3Solver(location: Z3Location, onBusyChange: (busy: boolean) => void) {
  let worker: Promise<Worker> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 1;
  const pending = new Map<number, { resolve: (responses: ts.VerificationSolverResponse[]) => void; reject: (error: Error) => void }>();

  /**
   * The worker and Z3's pthreads start from a blob of the script rather than its URL:
   * starting a nested worker from a URL fails in some browsers (an error event without
   * a message), while a same-origin blob works everywhere.
   */
  async function loadScript(): Promise<Blob> {
    const response = await fetch(location.workerUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${location.workerUrl}`);
    return new Blob([await response.text()], { type: "text/javascript" });
  }

  function start(): Promise<Worker> {
    return worker ??= loadScript().then(script => new Promise<Worker>((resolve, reject) => {
      const z3 = new Worker(URL.createObjectURL(script));
      z3.onmessage = event => {
        const data = event.data;
        if (data?.kind === "ready") resolve(z3);
        else if (data?.kind === "init-error") reject(new Error(`Z3 failed to start: ${data.error}`));
        else if (typeof data?.id === "number") {
          const request = pending.get(data.id);
          pending.delete(data.id);
          if (data.ok) request?.resolve(data.responses);
          else request?.reject(new Error(data.error));
        }
      };
      z3.onerror = event => reject(new Error(`Z3 worker error: ${event.message}`));
      z3.postMessage({ wasmUrl: location.wasmUrl, script });
    })).catch(error => {
      restart();
      throw error;
    });
  }

  function restart() {
    void worker?.then(z3 => z3.terminate(), () => {});
    worker = undefined;
    for (const request of pending.values()) request.reject(new Error("Z3 worker restarted"));
    pending.clear();
  }

  async function run(requests: readonly ts.VerificationSolverRequest[]) {
    const z3 = await start();
    const id = nextId++;
    try {
      const responses = await new Promise<ts.VerificationSolverResponse[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Z3 did not answer within ${queryTimeoutMs / 1000}s`)), queryTimeoutMs);
        pending.set(id, {
          resolve: value => (clearTimeout(timer), resolve(value)),
          reject: error => (clearTimeout(timer), reject(error)),
        });
        z3.postMessage({ id, requests });
      });
      if (responses.some(response => response.status === "error")) restart();
      return responses;
    }
    catch (error) {
      restart();
      throw error;
    }
  }

  /** CompilerHost.solveVerificationQueries */
  return (requests: readonly ts.VerificationSolverRequest[]): Promise<readonly ts.VerificationSolverResponse[]> => {
    const batch = queue.then(() => {
      onBusyChange(true);
      return run(requests).finally(() => onBusyChange(false));
    });
    queue = batch.catch(() => {});
    return batch;
  };
}
