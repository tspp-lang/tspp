import type { Request, Response, WorkerApi, WorkerEvent } from "./protocol";

export type LanguageClient = { [K in keyof WorkerApi]: (...args: Parameters<WorkerApi[K]>) => Promise<ReturnType<WorkerApi[K]>> };

/** Starts the language worker and exposes its API as promise-returning calls. */
export function startLanguageWorker(onEvent: (event: WorkerEvent) => void): LanguageClient {
  const worker = new Worker(new URL("./worker/languageWorker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;
  worker.onmessage = (event: MessageEvent<Response | WorkerEvent>) => {
    if ("event" in event.data) return onEvent(event.data);
    const response = event.data;
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    if ("error" in response) request.reject(new Error(response.error));
    else request.resolve(response.result);
  };
  worker.onerror = event => {
    const error = new Error(`Language worker failed: ${event.message}`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  return new Proxy({} as LanguageClient, {
    get: (_target, method: keyof WorkerApi | "then") => {
      // not a thenable, so the client can be returned from async functions
      if (method === "then") return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          worker.postMessage({ id, method, args } as Request);
        });
    },
  });
}
