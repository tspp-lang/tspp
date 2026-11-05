import type { LanguageClient } from "./client";
import * as monaco from "./monaco";
import type { FeatureDefinition, OutputCategory, OutputItem, OutputSnapshot, RunnableProgram } from "./protocol";
import { languageId } from "./tsppLanguage";

/** `feature` is the capsule that produces the artifact; without it there is nothing to ask the compiler for. */
const categories: { id: OutputCategory; label: string; feature?: string }[] = [
  { id: "javascript", label: "JavaScript" },
  { id: "dts", label: ".d.ts" },
  { id: "dtspp", label: ".d.tspp" },
];

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface OutputController {
  /** Adds the output tabs of the features the compiler offers, once it has loaded. */
  addFeatureOutputs(features: readonly FeatureDefinition[]): void;
  setFile(fileName: string, force?: boolean, sourceFile?: boolean): void;
  /** Explains why the current project cannot execute in the browser, or clears the restriction. */
  setRunBlock(reason: string | undefined): void;
  markStale(): void;
  refresh(): void;
  dispose(): void;
}

/** Owns lazily-loaded compiler artifacts and the explicitly-invoked runtime worker. */
export function createOutputController(client: LanguageClient, enabledFeatures: () => readonly string[]): OutputController {
  const editorColumn = element("editor-column");
  const outputTabs = element("output-tabs");
  const outputItems = element<HTMLSelectElement>("output-items");
  const outputStatus = element("outputs-status");
  const outputEmpty = element("output-empty");
  const runButton = element<HTMLButtonElement>("run-javascript");
  const runStatus = element("run-status");
  const runOutput = element("run-output");
  const loaded = new Map<OutputCategory, OutputSnapshot>();
  let category: OutputCategory = "javascript";
  let current: OutputItem | undefined;
  let outputModel: monaco.editor.ITextModel | undefined;
  let requestGeneration = 0;
  let fileName = "";
  let sourceFile = true;
  let runBlock: string | undefined;
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
  function addCategoryButton(definition: typeof categories[number]): void {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.category = definition.id;
    button.textContent = definition.label;
    button.onclick = () => void loadCategory(definition.id);
    categoryButtons.set(definition.id, button);
    outputTabs.append(button);
  }
  categories.forEach(addCategoryButton);

  function itemsForCategory(): readonly OutputItem[] {
    return loaded.get(category)?.items ?? [];
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
    showItem(items.find(item => item.id === preferredId) ?? outputForActiveFile(items) ?? items[0]);
    renderTabs();
  }

  function showItem(item: OutputItem | undefined): void {
    current = item;
    outputModel?.dispose();
    outputModel = undefined;
    artifactEditor.setModel(null);
    outputEmpty.classList.remove("loading");
    outputEmpty.hidden = !!item;
    if (!item) {
      const label = categories.find(definition => definition.id === category)?.label;
      outputEmpty.textContent = loaded.has(category)
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

  async function loadCategory(nextCategory: OutputCategory, preferredId?: string): Promise<void> {
    category = nextCategory;
    const cached = loaded.get(nextCategory);
    if (cached) {
      renderItems(current?.id);
      return;
    }
    const definition = categories.find(item => item.id === nextCategory)!;
    if (definition.feature && !enabledFeatures().includes(definition.feature)) {
      requestGeneration++;
      loaded.set(nextCategory, { items: [], diagnostics: [] });
      renderItems();
      outputStatus.textContent = "Not produced";
      return;
    }
    const generation = ++requestGeneration;
    current = undefined;
    outputModel?.dispose();
    outputModel = undefined;
    artifactEditor.setModel(null);
    outputItems.hidden = true;
    outputEmpty.hidden = false;
    outputEmpty.classList.add("loading");
    const label = definition.label;
    outputEmpty.textContent = `Generating ${label}…`;
    outputStatus.textContent = `Loading ${label}…`;
    renderTabs(nextCategory);
    try {
      const snapshot = await client.outputs(fileName, nextCategory);
      if (generation !== requestGeneration) return;
      loaded.set(nextCategory, snapshot);
      renderItems(preferredId);
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
    runButton.disabled = !sourceFile || !!runBlock;
    if (runBlock) runStatus.textContent = runBlock;
  }

  function setFile(nextFileName: string, force = false, nextSourceFile = true): void {
    if (fileName === nextFileName && sourceFile === nextSourceFile && !force) return;
    fileName = nextFileName;
    sourceFile = nextSourceFile;
    if (!sourceFile) {
      requestGeneration++;
      loaded.clear();
      renderItems();
      outputStatus.textContent = "Project configuration";
      outputEmpty.hidden = false;
      outputEmpty.textContent = "Compiler outputs are available for source files.";
      runStatus.textContent = "Run is available for source files.";
      updateRunButton();
      return;
    }
    markStale();
    outputStatus.textContent = "Load on demand";
    runStatus.textContent = "JavaScript output runs only when requested.";
    void loadCategory(category);
  }

  /** Generates what is on show, or being generated, again. Nothing the user has not asked for since the last edit. */
  function refresh(): void {
    if (!loaded.has(category) && !outputEmpty.classList.contains("loading")) return;
    const shown = current?.id;
    loaded.clear();
    void loadCategory(category, shown);
  }

  function markStale(): void {
    requestGeneration++;
    loaded.clear();
    renderItems();
    outputStatus.textContent = "Out of date — select an output to refresh";
    if (runtime) stopRuntime("Source changed; run output is stale.");
    else if (runBlock) runStatus.textContent = runBlock;
    else if (!sourceFile) runStatus.textContent = "Run is available for source files.";
    else runStatus.textContent = "Source changed; run output is stale.";
    updateRunButton();
  }

  function stopRuntime(message = "Stopped"): void {
    runtime?.terminate();
    runtime = undefined;
    runStatus.classList.remove("loading");
    element("run-pane").setAttribute("aria-busy", "false");
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

  function outputForActiveFile(items: readonly OutputItem[], outputCategory = category): OutputItem | undefined {
    const suffix = outputCategory === "javascript" ? ".js" : outputCategory === "dts" ? ".d.ts" : outputCategory === "dtspp" ? ".d.tspp" : undefined;
    const expected = suffix && fileName.replace(/^\//, "").replace(/\.(?:tspp|ts)$/, suffix);
    return items.find(item => item.fileName === fileName || expected && item.label.replace(/^\//, "") === expected);
  }

  async function runJavaScript(): Promise<void> {
    if (runBlock) {
      runStatus.textContent = runBlock;
      return;
    }
    if (runtime) {
      stopRuntime();
      return;
    }
    runButton.disabled = true;
    runButton.textContent = "Preparing…";
    runStatus.textContent = "Generating JavaScript…";
    runStatus.classList.add("loading");
    element("run-pane").setAttribute("aria-busy", "true");
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
      runStatus.classList.remove("loading");
      element("run-pane").setAttribute("aria-busy", "false");
      return;
    }
    const javascript = current?.category === "javascript"
      ? current
      : outputForActiveFile(snapshot.items, "javascript");
    if (!javascript) {
      runButton.disabled = false;
      runButton.textContent = "▶ Run";
      runStatus.textContent = "No JavaScript was emitted for this file.";
      runStatus.classList.remove("loading");
      element("run-pane").setAttribute("aria-busy", "false");
      return;
    }
    let runnable: RunnableProgram;
    try {
      runnable = await client.runnable(fileName, javascript.label);
    }
    catch (error) {
      runButton.disabled = false;
      runButton.textContent = "▶ Run";
      runStatus.textContent = `JavaScript generation failed: ${(error as Error).message}`;
      runStatus.classList.remove("loading");
      element("run-pane").setAttribute("aria-busy", "false");
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
    runtime.postMessage(runnable);
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
    addFeatureOutputs(features) {
      for (const feature of features) {
        for (const output of feature.outputs) {
          const definition = { ...output, feature: feature.id };
          categories.push(definition);
          addCategoryButton(definition);
        }
      }
    },
    setFile,
    setRunBlock(reason) {
      runBlock = reason;
      updateRunButton();
    },
    markStale,
    refresh,
    dispose() {
      stopRuntime();
      artifactEditor.dispose();
      outputModel?.dispose();
    },
  };
}
