import type { WorkerEvent } from "./protocol";

type SolverEvent = Extract<WorkerEvent, { readonly event: "solver" }>;

/** Visible text for a solver phase, or undefined once no solver work remains. */
export function solverStatusText(event: SolverEvent): string | undefined {
  if (event.phase === "idle") return undefined;
  if (event.phase === "initializing") return "Starting Z3 — first use may be slow…";
  if (event.phase === "solving") return "Verifying contracts…";
  const label = event.phase === "loading-wasm" ? "Downloading Z3 — first use may be slow" : "Loading Z3 worker";
  if (event.total) return `${label}… ${Math.min(100, Math.round((event.loaded ?? 0) / event.total * 100))}%`;
  if (event.loaded) return `${label}… ${(event.loaded / 1024 / 1024).toFixed(1)} MB`;
  return `${label}…`;
}

export function renderSolverStatus(element: HTMLElement, event: SolverEvent): void {
  const message = solverStatusText(event);
  element.hidden = !message;
  element.closest("section")?.setAttribute("aria-busy", String(!!message));
  if (message) element.textContent = message;
}
