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
  setFile(fileName: string): void;
  markStale(): void;
  dispose(): void;
}

/** Owns lazily-loaded compiler artifacts and the explicitly-invoked runtime worker. */
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
  const loaded = new Map<OutputCategory, OutputSnapshot>();
  let category: OutputCategory | undefined;
  let current: OutputItem | undefined;
  let outputModel: monaco.editor.ITextModel | undefined;
  let requestGeneration = 0;
  let fileName = "";
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
    button.onclick = () => void loadCategory(definition.id);
    categoryButtons.set(definition.id, button);
    outputTabs.append(button);
  }

  function itemsForCategory(): readonly OutputItem[] {
    return category ? loaded.get(category)?.items ?? [] : [];
  }

  function renderTabs(loading?: OutputCategory): void {
    for (const definition of categories) {
      const button = categoryButtons.get(definition.id)!;
      const count = loaded.get(definition.id)?.items.length ?? 0;
      button.disabled = loading !== undefined;
      button.classList.toggle("active", definition.id === category);
      button.textContent = `${definition.label}${count > 1 ? ` (${count})` : ""}`;
    }
  }

  function renderItems(preferredId?: string): void {
    const items = itemsForCategory();
    outputItems.replaceChildren(...items.map(item => new Option(item.label, item.id)));
    outputItems.disabled = items.length < 2;
    outputItems.hidden = items.length === 0;
    showItem(items.find(item => item.id === preferredId) ?? items[0]);
    renderTabs();
  }

  function showItem(item: OutputItem | undefined): void {
    current = item;
    outputModel?.dispose();
    outputModel = undefined;
    artifactEditor.setModel(null);
    outputEmpty.classList.remove("loading");
    outputEmpty.hidden = !!item;
    goToSource.disabled = !item?.fileName;
    if (!item) {
      const label = categories.find(definition => definition.id === category)?.label;
      outputEmpty.textContent = !category
        ? "Select an output type to generate it on demand."
        : loaded.has(category)
          ? "This artifact is not produced by the enabled features."
          : `Select ${label} to generate or refresh it.`;
      return;
    }
    outputItems.value = item.id;
    const language = item.language === "plaintext" ? "plaintext" : languageId;
    outputModel = monaco.editor.createModel(item.content, language);
    artifactEditor.setModel(outputModel);
  }

  outputItems.onchange = () => showItem(itemsForCategory().find(item => item.id === outputItems.value));
  goToSource.onclick = () => {
    if (current?.fileName) openSource(current.fileName, current.span?.start);
  };

  async function loadCategory(nextCategory: OutputCategory): Promise<void> {
    category = nextCategory;
    const cached = loaded.get(nextCategory);
    if (cached) {
      renderItems(current?.id);
      return;
    }
    const generation = ++requestGeneration;
    current = undefined;
    outputModel?.dispose();
    outputModel = undefined;
    artifactEditor.setModel(null);
    outputItems.hidden = true;
    goToSource.disabled = true;
    outputEmpty.hidden = false;
    outputEmpty.classList.add("loading");
    const label = categories.find(item => item.id === nextCategory)!.label;
    outputEmpty.textContent = `Generating ${label}…`;
    outputStatus.textContent = `Loading ${label}…`;
    renderTabs(nextCategory);
    try {
      const snapshot = await client.outputs(fileName, nextCategory);
      if (generation !== requestGeneration) return;
      loaded.set(nextCategory, snapshot);
      renderItems();
      outputStatus.textContent = snapshot.diagnostics.some(item => item.category === "error")
        ? "Generated with errors"
        : snapshot.items.length ? "Up to date" : "Not produced";
      updateRunButton();
    }
    catch (error) {
      if (generation !== requestGeneration) return;
      outputEmpty.classList.remove("loading");
      outputEmpty.textContent = `Generation failed: ${(error as Error).message}`;
      outputStatus.textContent = "Generation failed";
      renderTabs();
    }
  }

  function updateRunButton(): void {
    // JavaScript is generated lazily when Run is pressed. Its artifact tab does
    // not need to have been opened first.
    runButton.disabled = false;
  }

  function setFile(nextFileName: string): void {
    if (fileName === nextFileName) return;
    fileName = nextFileName;
    category = undefined;
    markStale();
    outputStatus.textContent = "Load on demand";
    runStatus.textContent = "JavaScript output runs only when requested.";
  }

  function markStale(): void {
    requestGeneration++;
    loaded.clear();
    renderItems();
    outputStatus.textContent = category ? "Out of date — select an output to refresh" : "Load on demand";
    updateRunButton();
    if (runtime) stopRuntime("Source changed; run output is stale.");
    else if (category) runStatus.textContent = "Source changed; run output is stale.";
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

  function emittedJavaScriptForActiveFile(items: readonly OutputItem[]): OutputItem | undefined {
    const expected = fileName.replace(/^\//, "").replace(/\.(?:tspp|ts)$/, ".js");
    return items.find(item => item.label.replace(/^\//, "") === expected) ?? items[0];
  }

  async function runJavaScript(): Promise<void> {
    if (runtime) {
      stopRuntime();
      return;
    }
    runButton.disabled = true;
    runButton.textContent = "Preparing…";
    runStatus.textContent = "Generating JavaScript…";
    let snapshot = loaded.get("javascript");
    try {
      snapshot ??= await client.outputs(fileName, "javascript");
      loaded.set("javascript", snapshot);
      renderTabs();
    }
    catch (error) {
      runButton.disabled = false;
      runButton.textContent = "▶ Run";
      runStatus.textContent = `JavaScript generation failed: ${(error as Error).message}`;
      return;
    }
    const javascript = current?.category === "javascript"
      ? current
      : emittedJavaScriptForActiveFile(snapshot.items);
    if (!javascript) {
      runButton.disabled = false;
      runButton.textContent = "▶ Run";
      runStatus.textContent = "No JavaScript was emitted for this file.";
      return;
    }
    runOutput.replaceChildren();
    runStatus.textContent = "Running…";
    runButton.disabled = false;
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

  runButton.onclick = () => void runJavaScript();
  element<HTMLButtonElement>("clear-run-output").onclick = () => runOutput.replaceChildren();
  element<HTMLButtonElement>("collapse-outputs").onclick = () => {
    editorColumn.classList.add("outputs-collapsed");
    artifactEditor.layout();
  };
  element<HTMLButtonElement>("expand-outputs").onclick = () => {
    editorColumn.classList.remove("outputs-collapsed");
    artifactEditor.layout();
  };
  element<HTMLButtonElement>("collapse-run").onclick = () => editorColumn.classList.add("run-collapsed");
  element<HTMLButtonElement>("expand-run").onclick = () => editorColumn.classList.remove("run-collapsed");

  renderItems();
  updateRunButton();
  return {
    setFile,
    markStale,
    dispose() {
      stopRuntime();
      artifactEditor.dispose();
      outputModel?.dispose();
    },
  };
}
