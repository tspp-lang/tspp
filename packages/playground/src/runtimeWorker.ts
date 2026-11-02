import type { RunnableProgram } from "./protocol";

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

self.onmessage = async (message: MessageEvent<RunnableProgram>) => {
  for (const level of ["log", "info", "warn", "error"] as const) {
    console[level] = (...values: unknown[]) => send({ type: "output", level, text: values.map(display).join(" ") });
  }
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
    await import(/* @vite-ignore */ link(message.data.entry));
    send({ type: "complete" });
  }
  catch (error) {
    send({ type: "error", text: error instanceof Error ? error.stack ?? error.message : String(error) });
  }
  finally {
    for (const url of urls.values()) URL.revokeObjectURL(url);
  }
};
