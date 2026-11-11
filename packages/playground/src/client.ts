import type { Cancel, Request, Response, WorkerApi, WorkerEvent } from "./protocol";

/** Monaco's CancellationToken, structurally. */
export interface Cancellation {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Every method takes an optional trailing cancellation; a cancelled call rejects with Monaco's "Canceled" error. */
export type LanguageClient = { dispose(): void } & {
  [K in keyof WorkerApi]: (...args: [...Parameters<WorkerApi[K]>, Cancellation?]) => Promise<Awaited<ReturnType<WorkerApi[K]>>>;
};

const isCancellation = (value: unknown): value is Cancellation =>
  typeof (value as Cancellation | undefined)?.onCancellationRequested === "function";

/** The error Monaco recognizes as a cancelled provider call and does not report. */
function canceled(): Error {
  const error = new Error("Canceled");
  error.name = "Canceled";
  return error;
}

// Formatting is not among them: a compiler without the project's capsules would format their syntax away.
const editorRequests = new Set<keyof WorkerApi>(["quickInfo", "completions", "completionDetails", "signatureHelp", "definition"]);

/** A stable RPC facade. Changing the capsule set starts a fresh compiler worker. */
export function startLanguageWorker(onEvent: (event: WorkerEvent) => void, initialZ3?: Parameters<WorkerApi["init"]>[0]): LanguageClient {
  const pending = new Map<number, { target: Worker; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let z3 = initialZ3;
  let featureSignature: string | undefined;
  let project: Record<string, string> = {};
  let projectVersion = 0;
  let hasFeatures = false;
  let recovery: { worker: Worker; version: number; ready: Promise<unknown> } | undefined;
  let worker = createWorker();
  let disposed = false;
  const ready = initialZ3 ? send("init", [initialZ3]) : Promise.resolve();
  let transition = ready;

  function createWorker(): Worker {
    const next = new Worker(new URL("./worker/languageWorker.ts", import.meta.url), { type: "module" });
    next.onmessage = (event: MessageEvent<Response | WorkerEvent>) => {
      if (disposed) return;
      if ("event" in event.data) {
        if (worker === next) onEvent(event.data);
        return;
      }
      const request = pending.get(event.data.id);
      if (request?.target !== next) return;
      pending.delete(event.data.id);
      if ("error" in event.data) request.reject(new Error(event.data.error));
      else request.resolve(event.data.result);
    };
    next.onerror = event => {
      if (disposed) return;
      rejectPending(new Error(`Language worker failed: ${event.message}`), next);
      if (recovery?.worker === next) disposeRecovery();
    };
    return next;
  }

  function rejectPending(error: Error, target?: Worker): void {
    for (const [id, request] of pending) {
      if (target && request.target !== target) continue;
      pending.delete(id);
      request.reject(error);
    }
  }

  function send(method: keyof WorkerApi, args: unknown[], cancellation?: Cancellation, target = worker): Promise<unknown> {
    if (disposed || cancellation?.isCancellationRequested) return Promise.reject(canceled());
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const subscription = cancellation?.onCancellationRequested(() => {
        if (!pending.delete(id)) return;
        target.postMessage({ cancel: id } satisfies Cancel);
        reject(canceled());
      });
      const settled = <T>(settle: (value: T) => void) => (value: T) => {
        subscription?.dispose();
        settle(value);
      };
      pending.set(id, { target, resolve: settled(resolve), reject: settled(reject) });
      try {
        target.postMessage({ id, method, args } as Request);
      }
      catch (error) {
        pending.delete(id);
        subscription?.dispose();
        reject(error);
      }
    });
  }

  function disposeRecovery(): void {
    recovery?.worker.terminate();
    recovery = undefined;
  }

  /** Reuse the current source and tsconfig in a separate compiler with no active capsules. */
  async function recoverEditorRequest(method: keyof WorkerApi, args: unknown[], version: number, cancellation?: Cancellation): Promise<unknown> {
    if (disposed || cancellation?.isCancellationRequested || version !== projectVersion) throw canceled();
    if (recovery?.version !== version) {
      const target = recovery?.worker ?? createWorker();
      recovery = { worker: target, version, ready: send("setProject", [project, []], undefined, target) };
    }
    const current = recovery;
    await current.ready;
    if (version !== projectVersion || recovery !== current) throw canceled();
    const result = await send(method, args, cancellation, current.worker);
    if (version !== projectVersion) throw canceled();
    return result;
  }

  async function restart(): Promise<void> {
    rejectPending(new Error("Compiler capsules changed; restarting the playground worker."));
    disposeRecovery();
    worker.terminate();
    worker = createWorker();
    if (z3) await send("init", [z3]);
  }

  return new Proxy({
    dispose() {
      disposed = true;
      rejectPending(canceled());
      disposeRecovery();
      worker.terminate();
    },
  } as LanguageClient, {
    get: (target, method: keyof LanguageClient | "then") => {
      if (method === "then") return undefined;
      if (method === "dispose") return target.dispose;
      return async (...args: unknown[]) => {
        const cancellation = isCancellation(args.at(-1)) ? args.pop() as Cancellation : undefined;
        if (method === "init") {
          z3 = args[0] as typeof z3;
          return send(method, args);
        }
        if (method === "setProject") {
          const [files, features] = args as Parameters<WorkerApi["setProject"]>;
          const signature = JSON.stringify(features);
          transition = transition.catch(() => undefined).then(async () => {
            await ready;
            if (disposed) throw canceled();
            projectVersion++;
            if (featureSignature !== undefined && featureSignature !== signature) await restart();
            featureSignature = signature;
            project = { ...files };
            hasFeatures = features.length > 0;
            return send(method, args);
          });
          return transition;
        }
        await transition;
        if (method === "editFile") {
          const [fileName, text] = args as Parameters<WorkerApi["editFile"]>;
          if (Object.hasOwn(project, fileName) && project[fileName] !== text) {
            project[fileName] = text;
            projectVersion++;
          }
        }
        const request = send(method, args, cancellation);
        if (!hasFeatures || !editorRequests.has(method)) return request;
        const version = projectVersion;
        return request.catch(error => {
          if (error.name === "Canceled") throw error;
          return recoverEditorRequest(method, args, version, cancellation);
        });
      };
    },
  });
}
