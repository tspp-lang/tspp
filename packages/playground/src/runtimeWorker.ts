interface RunRequest {
  readonly code: string;
}

type RunEvent =
  | { readonly type: "output"; readonly level: string; readonly text: string }
  | { readonly type: "complete" }
  | { readonly type: "error"; readonly text: string };

const send = (event: RunEvent) => self.postMessage(event);

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

self.onmessage = async (message: MessageEvent<RunRequest>) => {
  for (const level of ["log", "info", "warn", "error"] as const) {
    console[level] = (...values: unknown[]) => send({ type: "output", level, text: values.map(display).join(" ") });
  }
  const url = URL.createObjectURL(new Blob([message.data.code], { type: "text/javascript" }));
  try {
    await import(/* @vite-ignore */ url);
    send({ type: "complete" });
  }
  catch (error) {
    send({ type: "error", text: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
  finally {
    URL.revokeObjectURL(url);
  }
};
