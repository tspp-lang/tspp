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
  /** Marks the editor as newer than the saved project whose artifacts are shown. */
  setDirty(dirty: boolean): void;
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
  let dirty = false;
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

  function savedOutputStatus(): string {
    if (!sourceFile) return "Project configuration";
    const snapshot = loaded.get(category);
    if (!snapshot) return "Load on demand";
    if (snapshot.diagnostics.some(item => item.category === "error")) return "Generated with errors";
    return outputsForActiveFile(snapshot.items).length ? "Up to date" : "Not produced";
  }

  function renderTabs(loading?: OutputCategory): void {
    for (const definition of categories) {
      const button = categoryButtons.get(definition.id)!;
      const count = outputsForActiveFile(loaded.get(definition.id)?.items ?? [], definition.id).length;
      button.disabled = loading !== undefined;
      button.classList.toggle("active", definition.id === category);
      button.textContent = `${definition.label}${count > 1 ? ` (${count})` : ""}`;
    }
  }

  function renderItems(): void {
    showItems(outputsForActiveFile(itemsForCategory()));
    renderTabs();
  }

  function showItems(items: readonly OutputItem[]): void {
    current = items.length === 1 ? items[0] : undefined;
    outputModel?.dispose();
    outputModel = undefined;
    artifactEditor.setModel(null);
    outputEmpty.classList.remove("loading");
    outputEmpty.hidden = items.length > 0;
    if (!items.length) {
      const label = categories.find(definition => definition.id === category)?.label;
      outputEmpty.textContent = loaded.has(category)
        ? `No ${label} output was produced for ${fileName.replace(/^.*\//, "")}.`
        : `Select ${label} to generate or refresh it.`;
      return;
    }
    const language = items.every(item => item.language === items[0].language) && items[0].language !== "plaintext" ? languageId : "plaintext";
    const content = items.length === 1
      ? items[0].content
      : items.map(item => `// ── ${item.label} ──\n${item.content}`).join("\n\n");
    outputModel = monaco.editor.createModel(content, language);
    artifactEditor.setModel(outputModel);
  }

  async function loadCategory(nextCategory: OutputCategory): Promise<void> {
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
      renderItems();
      outputStatus.textContent = snapshot.diagnostics.some(item => item.category === "error")
        ? "Generated with errors"
        : outputsForActiveFile(snapshot.items, nextCategory).length ? "Up to date" : "Not produced";
      if (dirty) outputStatus.textContent = "Unsaved changes — showing saved output";
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
    dirty = false;
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
    loaded.clear();
    void loadCategory(category);
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

  function outputsForActiveFile(items: readonly OutputItem[], outputCategory = category): readonly OutputItem[] {
    const suffix = outputCategory === "javascript" ? ".js" : outputCategory === "dts" ? ".d.ts" : outputCategory === "dtspp" ? ".d.tspp" : undefined;
    const expected = suffix && fileName.replace(/^\//, "").replace(/\.(?:tspp|ts)$/, suffix);
    const exact = items.filter(item => item.fileName === fileName || expected && item.label.replace(/^\//, "") === expected);
    if (exact.length || !suffix) return exact;
    const expectedBase = fileName.replace(/^.*\//, "").replace(/\.(?:tspp|ts)$/, suffix);
    const byBaseName = items.filter(item => !item.fileName && item.label.replace(/^.*\//, "") === expectedBase);
    return byBaseName.length === 1 ? byBaseName : [];
  }

  function outputForActiveFile(items: readonly OutputItem[], outputCategory = category): OutputItem | undefined {
    return outputsForActiveFile(items, outputCategory)[0];
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
    setDirty(nextDirty) {
      dirty = nextDirty;
      outputStatus.textContent = dirty ? "Unsaved changes — showing saved output" : savedOutputStatus();
    },
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
