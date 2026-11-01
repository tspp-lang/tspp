import type { Request, Response, WorkerApi, WorkerEvent } from "./protocol";

export type LanguageClient = {
  [K in keyof WorkerApi]: (...args: Parameters<WorkerApi[K]>) => Promise<Awaited<ReturnType<WorkerApi[K]>>>;
};

/** A stable RPC facade. Changing the capsule set starts a fresh compiler worker. */
export function startLanguageWorker(onEvent: (event: WorkerEvent) => void): LanguageClient {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  let z3: Parameters<WorkerApi["init"]>[0] | undefined;
  let featureSignature: string | undefined;
  let transition: Promise<unknown> = Promise.resolve();
  let worker = createWorker();

  function createWorker(): Worker {
    const next = new Worker(new URL("./worker/languageWorker.ts", import.meta.url), { type: "module" });
    next.onmessage = (event: MessageEvent<Response | WorkerEvent>) => {
      if ("event" in event.data) return onEvent(event.data);
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if ("error" in event.data) request.reject(new Error(event.data.error));
      else request.resolve(event.data.result);
    };
    next.onerror = event => rejectPending(new Error(`Language worker failed: ${event.message}`));
    return next;
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  function send(method: keyof WorkerApi, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, method, args } as Request);
    });
  }

  async function restart(): Promise<void> {
    rejectPending(new Error("Compiler capsules changed; restarting the playground worker."));
    worker.terminate();
    worker = createWorker();
    if (z3) await send("init", [z3]);
  }

  return new Proxy({} as LanguageClient, {
    get: (_target, method: keyof WorkerApi | "then") => {
      if (method === "then") return undefined;
      return async (...args: unknown[]) => {
        if (method === "init") {
          z3 = args[0] as typeof z3;
          return send(method, args);
        }
        if (method === "setProject") {
          const signature = JSON.stringify(args[1]);
          transition = transition.catch(() => undefined).then(async () => {
            if (featureSignature !== undefined && featureSignature !== signature) await restart();
            featureSignature = signature;
            return send(method, args);
          });
          return transition;
        }
        await transition;
        return send(method, args);
      };
    },
  });
}
