import type { LanguageClient } from "./client";
import * as monaco from "./monaco";
import type { OutputCategory, OutputItem, OutputSnapshot } from "./protocol";
import { languageId } from "./tsppLanguage";

const categories: readonly { id: OutputCategory; label: string }[] = [
  { id: "javascript", label: "JavaScript" },
  { id: "dts", label: ".d.ts" },
  { id: "dtspp", label: ".d.tspp" },
  { id: "macro", label: "Macro expansion" },
  { id: "smt", label: "SMT-LIB2" },
];

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface OutputController {
  readonly expanded: boolean;
  markStale(): void;
  refresh(fileName: string): Promise<void>;
  runJavaScript(): void;
  dispose(): void;
}

/** Owns the read-only compiler artifacts and the explicitly-invoked runtime worker. */
export function createOutputController(
  client: LanguageClient,
  openSource: (fileName: string, offset?: number) => void,
): OutputController {
  const editorColumn = element("editor-column");
  const outputTabs = element("output-tabs");
  const outputItems = element<HTMLSelectElement>("output-items");
  const outputStatus = element("outputs-status");
  const outputEmpty = element("output-empty");
  const goToSource = element<HTMLButtonElement>("go-to-output-source");
  const runButton = element<HTMLButtonElement>("run-javascript");
  const runStatus = element("run-status");
  const runOutput = element("run-output");
  let snapshot: OutputSnapshot = { items: [], diagnostics: [] };
  let category: OutputCategory = "javascript";
  let current: OutputItem | undefined;
  let outputModel: monaco.editor.ITextModel | undefined;
  let requestGeneration = 0;
  let stale = true;
  let lastFile = "";
  let runtime: Worker | undefined;

  const artifactEditor = monaco.editor.create(element("output-editor"), {
    model: null,
    readOnly: true,
    domReadOnly: true,
    automaticLayout: true,
    minimap: { enabled: false },
    lineNumbers: "on",
    scrollBeyondLastLine: false,
    folding: true,
    renderValidationDecorations: "off",
  });

  const categoryButtons = new Map<OutputCategory, HTMLButtonElement>();
  for (const definition of categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.category = definition.id;
    button.textContent = definition.label;
    button.onclick = () => {
      category = definition.id;
      renderItems();
    };
    categoryButtons.set(definition.id, button);
    outputTabs.append(button);
  }

  function itemsForCategory(): readonly OutputItem[] {
    return snapshot.items.filter(item => item.category === category);
  }

  function renderItems(preferredId?: string): void {
    const items = itemsForCategory();
    for (const definition of categories) {
      const button = categoryButtons.get(definition.id)!;
      const count = snapshot.items.filter(item => item.category === definition.id).length;
      button.disabled = count === 0;
      button.classList.toggle("active", definition.id === category);
      button.textContent = `${definition.label}${count > 1 ? ` (${count})` : ""}`;
    }
    outputItems.replaceChildren(...items.map(item => new Option(item.label, item.id)));
    const next = items.find(item => item.id === preferredId) ?? items[0];
    outputItems.disabled = items.length < 2;
    outputItems.hidden = items.length === 0;
    showItem(next);
  }

  function showItem(item: OutputItem | undefined): void {
    current = item;
    outputModel?.dispose();
    outputModel = undefined;
    artifactEditor.setModel(null);
    outputEmpty.hidden = !!item;
    goToSource.disabled = !item?.fileName;
    if (!item) {
      outputEmpty.textContent = snapshot.items.length
        ? "This artifact is not produced by the enabled features."
        : "No compiler artifacts are available for this project.";
      return;
    }
    outputItems.value = item.id;
    const language = item.language === "plaintext" ? "plaintext" : languageId;
    outputModel = monaco.editor.createModel(item.content, language);
    artifactEditor.setModel(outputModel);
  }

  outputItems.onchange = () => showItem(snapshot.items.find(item => item.id === outputItems.value));
  goToSource.onclick = () => {
    if (current?.fileName) openSource(current.fileName, current.span?.start);
  };

  async function refresh(fileName: string): Promise<void> {
    lastFile = fileName;
    if (!fileName || !controller.expanded) return;
    const generation = ++requestGeneration;
    const selectedId = current?.id;
    outputStatus.textContent = "Generating…";
    try {
      const next = await client.outputs(fileName);
      if (generation !== requestGeneration) return;
      snapshot = next;
      stale = false;
      if (!snapshot.items.some(item => item.category === category)) {
        category = categories.find(definition => snapshot.items.some(item => item.category === definition.id))?.id ?? "javascript";
      }
      renderItems(selectedId);
      outputStatus.textContent = snapshot.diagnostics.some(item => item.category === "error")
        ? "Generated with errors"
        : "Up to date";
      runButton.disabled = !snapshot.items.some(item => item.category === "javascript");
    }
    catch (error) {
      if (generation !== requestGeneration) return;
      outputStatus.textContent = `Failed: ${(error as Error).message}`;
      runButton.disabled = true;
    }
  }

  function markStale(): void {
    stale = true;
    requestGeneration++;
    outputStatus.textContent = "Out of date";
    runButton.disabled = true;
    if (runtime) stopRuntime("Source changed; run output is stale.");
    else runStatus.textContent = "Source changed; run output is stale.";
  }

  function stopRuntime(message = "Stopped"): void {
    runtime?.terminate();
    runtime = undefined;
    runButton.textContent = "▶ Run";
    runStatus.textContent = message;
  }

  function appendRuntimeLine(text: string, level = "log"): void {
    const line = document.createElement("span");
    line.className = `runtime-${level}`;
    line.textContent = text + "\n";
    runOutput.append(line);
    runOutput.scrollTop = runOutput.scrollHeight;
  }

  function runJavaScript(): void {
    if (runtime) {
      stopRuntime();
      return;
    }
    const javascript = current?.category === "javascript"
      ? current
      : snapshot.items.find(item => item.category === "javascript");
    if (!javascript || stale) return;
    runOutput.replaceChildren();
    runStatus.textContent = "Running…";
    runButton.textContent = "■ Stop";
    runtime = new Worker(new URL("./runtimeWorker.ts", import.meta.url), { type: "module" });
    runtime.onmessage = (event: MessageEvent<{ type: string; text?: string; level?: string }>) => {
      if (event.data.type === "output") appendRuntimeLine(event.data.text ?? "", event.data.level);
      else if (event.data.type === "complete") stopRuntime("Exited successfully");
      else if (event.data.type === "error") {
        appendRuntimeLine(event.data.text ?? "Unknown runtime error", "error");
        stopRuntime("Execution failed");
      }
    };
    runtime.onerror = event => {
      appendRuntimeLine(event.message, "error");
      stopRuntime("Execution failed");
    };
    runtime.postMessage({ code: javascript.content });
  }

  runButton.onclick = runJavaScript;
  element<HTMLButtonElement>("clear-run-output").onclick = () => runOutput.replaceChildren();
  element<HTMLButtonElement>("collapse-outputs").onclick = () => {
    editorColumn.classList.add("outputs-collapsed");
    artifactEditor.layout();
  };
  element<HTMLButtonElement>("expand-outputs").onclick = () => {
    editorColumn.classList.remove("outputs-collapsed");
    artifactEditor.layout();
    if (stale) void refresh(lastFile);
  };
  element<HTMLButtonElement>("collapse-run").onclick = () => editorColumn.classList.add("run-collapsed");
  element<HTMLButtonElement>("expand-run").onclick = () => editorColumn.classList.remove("run-collapsed");

  const controller: OutputController = {
    get expanded() { return !editorColumn.classList.contains("outputs-collapsed"); },
    markStale,
    refresh,
    runJavaScript,
    dispose() {
      stopRuntime();
      artifactEditor.dispose();
      outputModel?.dispose();
    },
  };
  renderItems();
  runButton.disabled = true;
  return controller;
}
