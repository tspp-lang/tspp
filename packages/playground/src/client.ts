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

/** A stable RPC facade. Changing the capsule set starts a fresh compiler worker. */
export function startLanguageWorker(onEvent: (event: WorkerEvent) => void, initialZ3?: Parameters<WorkerApi["init"]>[0]): LanguageClient {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let z3 = initialZ3;
  let featureSignature: string | undefined;
  let worker = createWorker();
  let disposed = false;
  const ready = initialZ3 ? send("init", [initialZ3]) : Promise.resolve();
  let transition = ready;

  function createWorker(): Worker {
    const next = new Worker(new URL("./worker/languageWorker.ts", import.meta.url), { type: "module" });
    next.onmessage = (event: MessageEvent<Response | WorkerEvent>) => {
      if (disposed || worker !== next) return;
      if ("event" in event.data) return onEvent(event.data);
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if ("error" in event.data) request.reject(new Error(event.data.error));
      else request.resolve(event.data.result);
    };
    next.onerror = event => {
      if (!disposed && worker === next) rejectPending(new Error(`Language worker failed: ${event.message}`));
    };
    return next;
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function send(method: keyof WorkerApi, args: unknown[], cancellation?: Cancellation): Promise<unknown> {
    if (disposed || cancellation?.isCancellationRequested) return Promise.reject(canceled());
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const target = worker;
      const subscription = cancellation?.onCancellationRequested(() => {
        if (!pending.delete(id)) return;
        target.postMessage({ cancel: id } satisfies Cancel);
        reject(canceled());
      });
      const settled = <T>(settle: (value: T) => void) => (value: T) => {
        subscription?.dispose();
        settle(value);
      };
      pending.set(id, { resolve: settled(resolve), reject: settled(reject) });
      target.postMessage({ id, method, args } as Request);
    });
  }

  async function restart(): Promise<void> {
    rejectPending(new Error("Compiler capsules changed; restarting the playground worker."));
    worker.terminate();
    worker = createWorker();
    if (z3) await send("init", [z3]);
  }

  return new Proxy({
    dispose() {
      disposed = true;
      rejectPending(canceled());
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
          const signature = JSON.stringify(args[1]);
          transition = transition.catch(() => undefined).then(async () => {
            await ready;
            if (disposed) throw canceled();
            if (featureSignature !== undefined && featureSignature !== signature) await restart();
            featureSignature = signature;
            return send(method, args);
          });
          return transition;
        }
        await transition;
        return send(method, args, cancellation);
      };
    },
  });
}
