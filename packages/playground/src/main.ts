import "./style.css";
import examples from "virtual:tspp-examples";
import { startLanguageWorker } from "./client";
import { effectiveFeatures, renderFeaturePanel } from "./features";
import * as monaco from "./monaco";
import type { DiagnosticInfo, ProjectFiles } from "./protocol";
import { registerProviders, setDiagnosticMarkers } from "./providers";
import { decodeState, encodeState, type SharedState } from "./share";
import { languageId, registerTsppLanguage } from "./tsppLanguage";

self.MonacoEnvironment = {
  getWorker: () => new Worker(new URL("./editorWorker.ts", import.meta.url), { type: "module" }),
};

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status");
const exampleSelect = element<HTMLSelectElement>("examples");
const shareButton = element<HTMLButtonElement>("share");
const shareLink = element<HTMLInputElement>("share-link");
const tabBar = element("tabs");
const featureList = element("features");
const problemList = element("problems");
const problemCount = element("problem-count");

let compilerStatus = "Loading compiler…";
const client = startLanguageWorker(event => {
  if (event.event === "analysisSettled") void check();
  else status.textContent = event.busy ? "Z3 is verifying contracts…" : compilerStatus;
});
registerTsppLanguage();
registerProviders(client);

const dark = matchMedia("(prefers-color-scheme: dark)");
const editor = monaco.editor.create(element("editor"), {
  model: null,
  theme: dark.matches ? "vs-dark" : "vs",
  automaticLayout: true,
  minimap: { enabled: false },
  fontSize: 14,
  scrollBeyondLastLine: false,
  fixedOverflowWidgets: true,
});
dark.addEventListener("change", () => monaco.editor.setTheme(dark.matches ? "vs-dark" : "vs"));

const { version, features: definitions } = await client.init({
  workerUrl: new URL("z3/z3.worker.js", document.baseURI).href,
  wasmUrl: new URL("z3/z3-built.wasm", document.baseURI).href,
});
compilerStatus = status.textContent = `TypeScript ${version} base`;

// ---- project ---------------------------------------------------------------------------
const models = new Map<string, monaco.editor.ITextModel>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const selected = new Set<string>();
let active = "";

const currentFeatures = () => effectiveFeatures(definitions, selected);
const projectFiles = (): ProjectFiles => Object.fromEntries([...models].map(([path, model]) => [path, model.getValue()]));

function loadProject(state: SharedState) {
  for (const model of models.values()) model.dispose();
  models.clear();
  viewStates.clear();
  for (const [path, text] of Object.entries(state.files)) {
    const model = monaco.editor.createModel(text, /\.(tspp|ts)$/.test(path) ? languageId : "plaintext", monaco.Uri.file(path));
    model.onDidChangeContent(() => {
      void client.editFile(path, model.getValue());
      scheduleCheck();
    });
    models.set(path, model);
  }
  selected.clear();
  state.features.forEach(name => selected.add(name));
  refreshFeatures();
  void client.setProject(projectFiles(), currentFeatures());
  renderTabs();
  openFile(state.active);
}

function openFile(path: string) {
  const model = models.get(path);
  if (!model) return;
  if (active && models.has(active)) viewStates.set(active, editor.saveViewState());
  active = path;
  editor.setModel(model);
  const viewState = viewStates.get(path);
  if (viewState) editor.restoreViewState(viewState);
  for (const tab of tabBar.children) tab.classList.toggle("active", (tab as HTMLElement).dataset.path === path);
  scheduleCheck();
}

function renderTabs() {
  tabBar.hidden = models.size < 2;
  tabBar.replaceChildren(...[...models.keys()].map(path => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.dataset.path = path;
    tab.textContent = path.slice(1);
    tab.onclick = () => openFile(path);
    return tab;
  }));
}

// go to definition across files switches tabs
monaco.editor.registerEditorOpener({
  openCodeEditor(_source, resource, selectionOrPosition) {
    if (!models.has(resource.path)) return false;
    openFile(resource.path);
    if (monaco.Range.isIRange(selectionOrPosition)) {
      editor.setSelection(selectionOrPosition);
      editor.revealRangeInCenter(selectionOrPosition);
    }
    else if (selectionOrPosition) {
      editor.setPosition(selectionOrPosition);
      editor.revealPositionInCenter(selectionOrPosition);
    }
    return true;
  },
});

// ---- examples ------------------------------------------------------------------------
for (const example of examples) exampleSelect.append(new Option(example.id, example.id));
const exampleState = (id: string): SharedState | undefined => {
  const example = examples.find(e => e.id === id);
  return example && { files: example.files, features: example.features, active: example.entry };
};
exampleSelect.onchange = () => {
  const state = exampleState(exampleSelect.value);
  if (state) loadProject(state);
};

/** Shows the example name while the project is still exactly that example. */
function syncExampleSelect() {
  const files = projectFiles();
  const matching = examples.find(example =>
    Object.keys(example.files).length === models.size && Object.entries(example.files).every(([path, text]) => files[path] === text)
  );
  exampleSelect.value = matching?.id ?? "";
}

// ---- features ------------------------------------------------------------------------
const refreshFeatures = renderFeaturePanel(featureList, definitions, () => selected, (name, checked) => {
  if (checked) selected.add(name);
  else selected.delete(name);
  refreshFeatures();
  void client.setProject(projectFiles(), currentFeatures());
  scheduleCheck();
});

// ---- checking ------------------------------------------------------------------------
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let checkGeneration = 0;

/** Type checks the open file after a pause, and keeps the share link in the URL current. */
function scheduleCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(check, 300);
  history.replaceState(null, "", "#" + encodeState({ files: projectFiles(), features: [...selected], active }));
  shareLink.hidden = true;
  syncExampleSelect();
}

async function check() {
  const generation = ++checkGeneration;
  const model = models.get(active);
  if (!model) return;
  let diagnostics: DiagnosticInfo[];
  try {
    diagnostics = await client.diagnostics(active);
  }
  catch (error) {
    // a crash in the compiler must not look like a clean file
    diagnostics = [{ message: `Type checking failed: ${(error as Error).message}`, code: 0, category: "error", unnecessary: false, deprecated: false }];
  }
  if (generation !== checkGeneration || model.isDisposed()) return;
  setDiagnosticMarkers(model, diagnostics);
  renderProblems(model, diagnostics.filter(d => d.category !== "suggestion"));
}

function renderProblems(model: monaco.editor.ITextModel, problems: readonly DiagnosticInfo[]) {
  problemCount.textContent = String(problems.length);
  problemList.replaceChildren(...problems.map(problem => {
    const item = document.createElement("li");
    item.className = `problem ${problem.category}`;
    const location = document.createElement("span");
    location.className = "problem-location";
    const message = document.createElement("span");
    message.className = "problem-message";
    message.textContent = problem.code ? `${problem.message} (TS${problem.code})` : problem.message;
    if (problem.span) {
      const position = model.getPositionAt(problem.span.start);
      location.textContent = `${position.lineNumber}:${position.column}`;
      item.onclick = () => {
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
        editor.focus();
      };
    }
    item.append(location, message);
    return item;
  }));
}

loadProject(decodeState(location.hash) ?? exampleState(examples[0].id)!);

// a pasted share link in the same tab only changes the hash
window.addEventListener("hashchange", () => {
  const state = decodeState(location.hash);
  if (state) loadProject(state);
});

// ---- sharing -------------------------------------------------------------------------
shareButton.onclick = async () => {
  try {
    await navigator.clipboard.writeText(location.href);
  }
  catch {
    // clipboard access denied (permissions, unfocused document): show the link to copy by hand
    shareLink.value = location.href;
    shareLink.hidden = false;
    shareLink.select();
    return;
  }
  shareButton.textContent = "Link copied";
  setTimeout(() => shareButton.textContent = "Share", 1500);
};
