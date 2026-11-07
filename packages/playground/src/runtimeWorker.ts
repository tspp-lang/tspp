import type { RunnableProgram } from "./protocol";

type RunEvent =
  | { readonly type: "output"; readonly level: string; readonly text: string }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly text: string };

const worker = self as unknown as DedicatedWorkerGlobalScope;
const send = (event: RunEvent) => worker.postMessage(event);

function display(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  try {
    return JSON.stringify(value, undefined, 2) ?? String(value);
  }
  catch {
    return String(value);
  }
}

/** Tracks work started by the program in this worker, which serves a single Run. */
function trackAsyncWork(): () => Promise<void> {
  const setTimeout = worker.setTimeout.bind(worker);
  const setInterval = worker.setInterval.bind(worker);
  const clearTimeout = worker.clearTimeout.bind(worker);
  const fetch = worker.fetch.bind(worker);
  const timers = new Set<number>();
  let pendingRequests = 0;
  let revision = 0;
  let checkIdle: (() => void) | undefined;
  function changed() {
    revision++;
    checkIdle?.();
  }

  worker.setTimeout = (handler, delay, ...args) => {
    if (typeof handler !== "function") return setTimeout(handler, delay, ...args);
    const id = setTimeout(() => {
      timers.delete(id);
      try {
        Reflect.apply(handler, worker, args);
      }
      finally {
        changed();
      }
    }, delay);
    timers.add(id);
    changed();
    return id;
  };
  worker.setInterval = (handler, delay, ...args) => {
    const id = setInterval(handler, delay, ...args);
    timers.add(id);
    changed();
    return id;
  };
  worker.clearTimeout = worker.clearInterval = id => {
    const timer = id === undefined ? undefined : id | 0;
    clearTimeout(timer);
    if (timer !== undefined && timers.delete(timer)) changed();
  };

  function trackRequest<T>(request: Promise<T>): Promise<T> {
    pendingRequests++;
    changed();
    return request.finally(() => {
      pendingRequests--;
      changed();
    });
  }
  worker.fetch = (...args) => trackRequest(fetch(...args));
  // Fetch can resolve at the headers while the body is still arriving.
  for (const method of ["arrayBuffer", "blob", "bytes", "formData", "json", "text"] as const) {
    const read = Response.prototype[method];
    if (!read) continue;
    Object.defineProperty(Response.prototype, method, {
      value(this: Response) { return trackRequest(read.call(this)); },
    });
  }

  return async () => {
    const channelName = `tspp-run-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`;
    const sender = new BroadcastChannel(channelName);
    const receiver = new BroadcastChannel(channelName);
    try {
      await new Promise<void>(resolve => {
        let scheduled = false;
        checkIdle = () => {
          if (scheduled || timers.size || pendingRequests) return;
          scheduled = true;
          const checkpoint = revision;
          // Yield through a microtask checkpoint, then queue on the same task source as unhandledrejection.
          setTimeout(() => sender.postMessage(checkpoint), 0);
        };
        receiver.onmessage = ({ data }) => {
          scheduled = false;
          if (data === revision && !timers.size && !pendingRequests) resolve();
          else checkIdle?.();
        };
        checkIdle();
      });
    }
    finally {
      checkIdle = undefined;
      sender.close();
      receiver.close();
    }
  };
}

worker.onmessage = async (message: MessageEvent<RunnableProgram>) => {
  for (const level of ["log", "info", "warn", "error"] as const) {
    console[level] = (...values: unknown[]) => send({ type: "output", level, text: values.map(display).join(" ") });
  }
  let failed = false;
  const fail = (error: unknown) => {
    if (failed) return;
    failed = true;
    send({ type: "error", text: error instanceof Error ? error.stack ?? error.message : String(error) });
  };
  worker.addEventListener("error", event => {
    event.preventDefault();
    fail(event.error ?? event.message);
  });
  worker.addEventListener("unhandledrejection", event => {
    event.preventDefault();
    fail(event.reason);
  });
  const urls = new Map<string, string>();
  /** An address for a module, whose imports name the addresses of the modules they mean. A cycle stays unresolved. */
  const link = (fileName: string): string => {
    const known = urls.get(fileName);
    if (known) return known;
    urls.set(fileName, fileName);
    const { code, imports } = message.data.modules[fileName];
    let linked = code;
    for (const { start, end, target } of [...imports].sort((left, right) => right.start - left.start)) {
      linked = linked.slice(0, start) + link(target) + linked.slice(end);
    }
    const url = URL.createObjectURL(new Blob([linked], { type: "text/javascript" }));
    urls.set(fileName, url);
    return url;
  };
  try {
    const waitForAsyncWork = trackAsyncWork();
    if (message.data.format === "commonjs") {
      const cache = new Map<string, { exports: unknown }>();
      const execute = (fileName: string): unknown => {
        const known = cache.get(fileName);
        if (known) return known.exports;
        const runnable = message.data.modules[fileName];
        const module = { exports: {} as unknown };
        cache.set(fileName, module);
        const targets = new Map(runnable.imports.map(item => [item.specifier, item.target]));
        const require = (specifier: string) => {
          const target = targets.get(specifier);
          if (!target) throw new Error(`Cannot require '${specifier}' from '${fileName}' in the Playground runtime.`);
          return execute(target);
        };
        new Function("require", "exports", "module", runnable.code)(require, module.exports, module);
        return module.exports;
      };
      execute(message.data.entry);
    }
    else await import(/* @vite-ignore */ link(message.data.entry));
    await waitForAsyncWork();
    if (!failed) send({ type: "complete" });
  }
  catch (error) {
    fail(error);
  }
  finally {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
};
