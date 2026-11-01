import * as formalVerificationNamespace from "@tspp/plugin-formal-verification";
import type { Z3Answer, Z3Query, Z3Solver } from "@tspp/plugin-formal-verification";

const queryTimeoutMs = 120_000;
const formalVerificationExports = "verificationProgramSemantics" in formalVerificationNamespace
  ? formalVerificationNamespace
  : (formalVerificationNamespace as unknown as { default: typeof formalVerificationNamespace }).default;
const verificationProgramSemantics = (formalVerificationExports as {
  readonly verificationProgramSemantics: string;
}).verificationProgramSemantics;

export interface Z3Location {
  readonly workerUrl: string;
  readonly wasmUrl: string;
}

interface PendingRequest {
  readonly resolve: (answers: readonly Z3Answer[]) => void;
  readonly reject: (error: Error) => void;
}

export function createBrowserZ3Solver(location: Z3Location, onBusy?: (busy: boolean) => void): Z3Solver {
  let worker: Promise<Worker> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();

  async function loadScript(): Promise<Blob> {
    const response = await fetch(location.workerUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${location.workerUrl}`);
    return new Blob([await response.text()], { type: "text/javascript" });
  }

  function start(): Promise<Worker> {
    return worker ??= loadScript().then(script => new Promise<Worker>((resolve, reject) => {
      const z3 = new Worker(URL.createObjectURL(script));
      z3.onmessage = ({ data }) => {
        if (data?.kind === "ready") resolve(z3);
        else if (data?.kind === "init-error") reject(new Error(`Z3 failed to start: ${data.error}`));
        else if (typeof data?.id === "number") settle(data);
      };
      z3.onerror = event => reject(new Error(`Z3 worker error: ${event.message}`));
      z3.postMessage({ wasmUrl: location.wasmUrl, script });
    })).catch(error => {
      restart();
      throw error;
    });
  }

  function settle(data: { id: number; ok: boolean; answers?: readonly Z3Answer[]; error?: string }): void {
    const request = pending.get(data.id);
    pending.delete(data.id);
    if (data.ok && data.answers) request?.resolve(data.answers);
    else request?.reject(new Error(data.error ?? "Z3 failed to answer."));
  }

  function restart(): void {
    void worker?.then(z3 => z3.terminate(), () => {});
    worker = undefined;
    for (const request of pending.values()) request.reject(new Error("Z3 worker restarted."));
    pending.clear();
  }

  async function run(queries: readonly Z3Query[]): Promise<readonly Z3Answer[]> {
    onBusy?.(true);
    try {
      const z3 = await start();
      const id = nextId++;
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Z3 did not answer within ${queryTimeoutMs / 1000}s.`)), queryTimeoutMs);
        pending.set(id, {
          resolve: answers => { clearTimeout(timer); resolve(answers); },
          reject: error => { clearTimeout(timer); reject(error); },
        });
        z3.postMessage({ id, queries, programSemantics: verificationProgramSemantics });
      });
    }
    catch (error) {
      restart();
      throw error;
    }
    finally {
      onBusy?.(false);
    }
  }

  return queries => {
    const batch = queue.then(() => run(queries));
    queue = batch.catch(() => {});
    return batch;
  };
}
