import "./style.css";
import { effectiveFeatures, features } from "./features";
import type { WorkerResponse } from "./protocol";

const source = document.querySelector<HTMLTextAreaElement>("#source")!;
const projected = document.querySelector<HTMLTextAreaElement>("#projected")!;
const diagnostics = document.querySelector<HTMLElement>("#diagnostics")!;
const status = document.querySelector<HTMLElement>("#status")!;
const featurePanel = document.querySelector<HTMLElement>("#features")!;
const selected = new Set(features.map(feature => feature.id));
let worker: Worker | undefined;
let checkTimer: number | undefined;

source.value = `const answer: number = let left = 20, right = 22 in left + right;\nconsole.log(answer);\n`;

for (const feature of features) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = true;
  input.onchange = () => {
    if (input.checked) selected.add(feature.id);
    else selected.delete(feature.id);
    restartWorker();
  };
  label.append(input, document.createTextNode(feature.name));
  featurePanel.append(label);
}

source.addEventListener("input", scheduleCheck);
restartWorker();

function restartWorker(): void {
  worker?.terminate();
  status.textContent = "loading capsules…";
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
    if (data.type === "ready") {
      status.textContent = "ready";
      check();
    }
    else if (data.type === "result") {
      projected.value = data.result.projected;
      diagnostics.textContent = data.result.diagnostics.join("\n") || "No diagnostics.";
      status.textContent = "ready";
    }
    else {
      diagnostics.textContent = data.message;
      status.textContent = "failed";
    }
  };
  worker.postMessage({ type: "initialize", features: effectiveFeatures(selected) });
}

function scheduleCheck(): void {
  window.clearTimeout(checkTimer);
  checkTimer = window.setTimeout(check, 150);
}

function check(): void {
  status.textContent = "checking…";
  worker?.postMessage({ type: "check", source: source.value });
}
