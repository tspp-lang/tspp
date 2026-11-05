import examples from "virtual:tspp-examples";
import { startLanguageWorker } from "./client";
import { effectiveFeatures, renderFeaturePanel } from "./features";
import * as monaco from "./monaco";
import { createOutputController } from "./outputs";
import { baseName, normalizedPath, parentDirectory, renderProjectTree as renderTree } from "./projectTree";
import type { DiagnosticInfo, ProjectFiles } from "./protocol";
import { registerProviders, setDiagnosticMarkers } from "./providers";
import { decodeState, encodeState, type SharedState } from "./share";
import { languageId, registerTsppLanguage } from "./tsppLanguage";

self.MonacoEnvironment = {
  getWorker: () => new Worker(new URL("./editorWorker.ts", import.meta.url), { type: "module" }),
};

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status");
// Read from the running bundle, so a stale cache shows the commit it actually serves.
const buildCommit = element<HTMLAnchorElement>("build-commit");
if (__TSPP_BUILD_COMMIT__) {
  buildCommit.textContent = __TSPP_BUILD_COMMIT__.slice(0, 9);
  buildCommit.href = `https://github.com/tspp-lang/tspp/commit/${__TSPP_BUILD_COMMIT__}`;
  buildCommit.hidden = false;
}
const exampleSelect = element<HTMLSelectElement>("examples");
const shareButton = element<HTMLButtonElement>("share");
const shareLink = element<HTMLInputElement>("share-link");
const editorColumn = element("editor-column");
const tabBar = element("tabs");
const projectTree = element("project-tree");
const renameProjectItem = element<HTMLButtonElement>("rename-project-item");
const deleteProjectItem = element<HTMLButtonElement>("delete-project-item");
const featureList = element("features");
const problemList = element("problems");
const problemCount = element("problem-count");
const analysisStatus = element("analysis-status");
const bootOverlay = element("boot-overlay");
const bootDetail = element("boot-detail");

const client = startLanguageWorker(event => {
  // several background runs (macros, then analyzers) often settle together
  if (event.event === "analysisSettled") requestCheck(50);
  else if (event.event === "programChanged") {
    requestCheck(50);
    outputs.refresh();
  }
  else {
    analysisStatus.hidden = !event.busy;
    analysisStatus.closest("section")?.setAttribute("aria-busy", String(event.busy));
  }
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
const outputs = createOutputController(client, () => currentFeatures());
dark.addEventListener("change", () => monaco.editor.setTheme(dark.matches ? "vs-dark" : "vs"));

let initialization: Awaited<ReturnType<typeof client.init>>;
try {
  initialization = await client.init({
    workerUrl: new URL("z3/z3.worker.js", document.baseURI).href,
    wasmUrl: new URL("z3/z3-built.wasm", document.baseURI).href,
  });
}
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = "Compiler failed to load";
  bootOverlay.classList.add("failed");
  bootDetail.textContent = `Could not start the compiler: ${message}`;
  throw error;
}
const { version, features: definitions } = initialization;
outputs.addFeatureOutputs(definitions);
status.textContent = `TypeScript ${version} base`;
bootOverlay.hidden = true;

// ---- project ---------------------------------------------------------------------------
const models = new Map<string, monaco.editor.ITextModel>();
const resources = new Map<string, string>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
const directories = new Set<string>();
const expandedDirectories = new Set<string>();
const selected = new Set<string>();
let active = "";
let selectedProjectItem = "";

const currentFeatures = () => effectiveFeatures(definitions, selected);
const isEditorFile = (path: string) => /\.(tspp|ts)$/.test(path);
const projectFiles = (): ProjectFiles => Object.fromEntries([
  ...resources,
  ...[...models].map(([path, model]) => [path, model.getValue()] as const),
]);

function addParentDirectories(path: string, target = directories): void {
  for (let parent = parentDirectory(path); parent !== "/"; parent = parentDirectory(parent)) target.add(parent);
}

function createSourceModel(path: string, text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, languageId, monaco.Uri.file(path));
  model.onDidChangeContent(() => {
    void client.editFile(path, model.getValue());
    outputs.markStale();
    scheduleCheck();
  });
  return model;
}

function loadProject(state: SharedState) {
  for (const model of models.values()) model.dispose();
  models.clear();
  resources.clear();
  viewStates.clear();
  directories.clear();
  expandedDirectories.clear();
  for (const [path, text] of Object.entries(state.files)) {
    addParentDirectories(path);
    if (!isEditorFile(path)) {
      resources.set(path, text);
      continue;
    }
    models.set(path, createSourceModel(path, text));
  }
  state.directories?.map(normalizedPath).filter(path => path !== "/").forEach(path => directories.add(path));
  directories.forEach(path => expandedDirectories.add(path));
  selected.clear();
  state.features.forEach(name => selected.add(name));
  selectedProjectItem = state.active;
  refreshFeatures();
  void client.setProject(projectFiles(), currentFeatures());
  outputs.markStale();
  renderTabs();
  renderProjectTree();
  openFile(state.active, true);
}

function openFile(path: string, refreshOutput = false) {
  const model = models.get(path);
  if (!model) return;
  if (active && models.has(active)) viewStates.set(active, editor.saveViewState());
  active = path;
  outputs.setFile(path, refreshOutput);
  editor.setModel(model);
  const viewState = viewStates.get(path);
  if (viewState) editor.restoreViewState(viewState);
  for (const tab of Array.from(tabBar.children)) tab.classList.toggle("active", (tab as HTMLElement).dataset.path === path);
  selectedProjectItem = path;
  renderProjectTree();
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

function renderProjectTree(): void {
  const files = new Map([
    ...[...models.keys()].map(path => [path, true] as const),
    ...[...resources.keys()].map(path => [path, false] as const),
  ]);
  const hasSelection = renderTree(projectTree, {
    directories,
    expandedDirectories,
    files,
    active,
    selected: selectedProjectItem,
  }, (path, directory) => {
    selectedProjectItem = path;
    if (directory) {
      if (expandedDirectories.has(path)) expandedDirectories.delete(path);
      else expandedDirectories.add(path);
      renderProjectTree();
    }
    else if (models.has(path)) openFile(path);
    else renderProjectTree();
  });
  renameProjectItem.disabled = !hasSelection;
  deleteProjectItem.disabled = !hasSelection;
}

function selectedDirectory(): string {
  if (directories.has(selectedProjectItem)) return selectedProjectItem;
  if (models.has(selectedProjectItem) || resources.has(selectedProjectItem)) return parentDirectory(selectedProjectItem);
  return directories.has("/src") ? "/src" : "/";
}

function validItemName(value: string | null): string | undefined {
  const name = value?.trim();
  return name && name !== "." && name !== ".." && !/[\\/]/.test(name) ? name : undefined;
}

function projectPathExists(path: string): boolean {
  return directories.has(path) || models.has(path) || resources.has(path);
}

function syncProjectChange(nextActive = active): void {
  void client.setProject(projectFiles(), currentFeatures());
  outputs.markStale();
  renderTabs();
  renderProjectTree();
  openFile(models.has(nextActive) ? nextActive : models.keys().next().value!, true);
}

function createFile(): void {
  const name = validItemName(prompt("New source file name", "untitled.tspp"));
  if (!name) return;
  if (!isEditorFile(name)) {
    alert("Source files must end in .tspp or .ts.");
    return;
  }
  const path = normalizedPath(`${selectedDirectory()}/${name}`);
  if (projectPathExists(path)) {
    alert(`${path} already exists.`);
    return;
  }
  addParentDirectories(path);
  models.set(path, createSourceModel(path, ""));
  selectedProjectItem = path;
  active = path;
  syncProjectChange(path);
  editor.focus();
}

function createFolder(): void {
  const name = validItemName(prompt("New folder name", "folder"));
  if (!name) return;
  const path = normalizedPath(`${selectedDirectory()}/${name}`);
  if (projectPathExists(path)) {
    alert(`${path} already exists.`);
    return;
  }
  directories.add(path);
  expandedDirectories.add(path);
  selectedProjectItem = path;
  renderProjectTree();
  scheduleCheck();
}

function replacePrefix(path: string, oldPrefix: string, nextPrefix: string): string {
  return path === oldPrefix ? nextPrefix : nextPrefix + path.slice(oldPrefix.length);
}

function renameSelectedItem(): void {
  const oldPath = selectedProjectItem;
  if (!projectPathExists(oldPath)) return;
  const directory = directories.has(oldPath);
  const name = validItemName(prompt(`Rename ${baseName(oldPath)}`, baseName(oldPath)));
  if (!name || name === baseName(oldPath)) return;
  if (!directory && models.has(oldPath) && !isEditorFile(name)) {
    alert("Source files must end in .tspp or .ts.");
    return;
  }
  const nextPath = normalizedPath(`${parentDirectory(oldPath)}/${name}`);
  if (projectPathExists(nextPath)) {
    alert(`${nextPath} already exists.`);
    return;
  }
  if (directory) {
    const movedModels = [...models].filter(([path]) => path.startsWith(`${oldPath}/`));
    const movedResources = [...resources].filter(([path]) => path.startsWith(`${oldPath}/`));
    for (const [path, model] of movedModels) {
      const movedPath = replacePrefix(path, oldPath, nextPath);
      const text = model.getValue();
      model.dispose();
      models.delete(path);
      models.set(movedPath, createSourceModel(movedPath, text));
      const viewState = viewStates.get(path);
      if (viewState) viewStates.set(movedPath, viewState);
      viewStates.delete(path);
    }
    for (const [path, text] of movedResources) {
      resources.delete(path);
      resources.set(replacePrefix(path, oldPath, nextPath), text);
    }
    const movedDirectories = [...directories].filter(path => path === oldPath || path.startsWith(`${oldPath}/`));
    for (const path of movedDirectories) directories.delete(path);
    movedDirectories.forEach(path => directories.add(replacePrefix(path, oldPath, nextPath)));
    const movedExpanded = [...expandedDirectories].filter(path => path === oldPath || path.startsWith(`${oldPath}/`));
    for (const path of movedExpanded) expandedDirectories.delete(path);
    movedExpanded.forEach(path => expandedDirectories.add(replacePrefix(path, oldPath, nextPath)));
    if (active.startsWith(`${oldPath}/`)) active = replacePrefix(active, oldPath, nextPath);
  }
  else if (models.has(oldPath)) {
    const oldModel = models.get(oldPath)!;
    const text = oldModel.getValue();
    oldModel.dispose();
    models.delete(oldPath);
    models.set(nextPath, createSourceModel(nextPath, text));
    const viewState = viewStates.get(oldPath);
    if (viewState) viewStates.set(nextPath, viewState);
    viewStates.delete(oldPath);
    if (active === oldPath) active = nextPath;
  }
  else {
    const text = resources.get(oldPath)!;
    resources.delete(oldPath);
    resources.set(nextPath, text);
  }
  addParentDirectories(nextPath);
  selectedProjectItem = nextPath;
  syncProjectChange(active);
}

function deleteSelectedProjectItem(): void {
  const path = selectedProjectItem;
  if (!projectPathExists(path)) return;
  const directory = directories.has(path);
  const affectedSources = [...models.keys()].filter(file => file === path || directory && file.startsWith(`${path}/`));
  if (models.size - affectedSources.length < 1) {
    alert("A playground project must keep at least one source file.");
    return;
  }
  if (!confirm(`Delete ${directory ? "folder" : "file"} ${baseName(path)}${directory ? " and its contents" : ""}?`)) return;
  for (const file of affectedSources) {
    models.get(file)?.dispose();
    models.delete(file);
    viewStates.delete(file);
  }
  for (const file of [...resources.keys()]) {
    if (file === path || directory && file.startsWith(`${path}/`)) resources.delete(file);
  }
  if (directory) {
    for (const candidate of [...directories]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) directories.delete(candidate);
    }
    for (const candidate of [...expandedDirectories]) {
      if (candidate === path || candidate.startsWith(`${path}/`)) expandedDirectories.delete(candidate);
    }
  }
  selectedProjectItem = parentDirectory(path);
  if (!directories.has(selectedProjectItem)) selectedProjectItem = "";
  syncProjectChange(models.has(active) ? active : models.keys().next().value!);
}

element<HTMLButtonElement>("new-file").onclick = createFile;
element<HTMLButtonElement>("new-folder").onclick = createFolder;
renameProjectItem.onclick = renameSelectedItem;
deleteProjectItem.onclick = deleteSelectedProjectItem;
element<HTMLButtonElement>("collapse-tree").onclick = () => {
  expandedDirectories.clear();
  renderProjectTree();
};
element<HTMLButtonElement>("collapse-project").onclick = () => editorColumn.classList.add("project-collapsed");
element<HTMLButtonElement>("expand-project").onclick = () => editorColumn.classList.remove("project-collapsed");

const projectResizer = element("project-resizer");
projectResizer.onpointerdown = event => {
  projectResizer.setPointerCapture(event.pointerId);
  projectResizer.classList.add("dragging");
};
projectResizer.onpointermove = event => {
  if (!projectResizer.hasPointerCapture(event.pointerId)) return;
  const left = element("source-workspace").getBoundingClientRect().left;
  const width = Math.max(160, Math.min(360, event.clientX - left));
  element("source-workspace").style.setProperty("--project-width", `${width}px`);
};
projectResizer.onpointerup = event => {
  projectResizer.releasePointerCapture(event.pointerId);
  projectResizer.classList.remove("dragging");
};
projectResizer.onkeydown = event => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const workspace = element("source-workspace");
  const current = Number.parseFloat(getComputedStyle(workspace).getPropertyValue("--project-width")) || 220;
  const next = Math.max(160, Math.min(360, current + (event.key === "ArrowLeft" ? -10 : 10)));
  workspace.style.setProperty("--project-width", `${next}px`);
  event.preventDefault();
};

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
    Object.keys(example.files).length === Object.keys(files).length && Object.entries(example.files).every(([path, text]) => files[path] === text)
  );
  exampleSelect.value = matching?.id ?? "";
}

// ---- features ------------------------------------------------------------------------
const refreshFeatures = renderFeaturePanel(featureList, definitions, () => selected, (name, checked) => {
  if (checked) selected.add(name);
  else selected.delete(name);
  refreshFeatures();
  outputs.markStale();
  void client.setProject(projectFiles(), currentFeatures());
  scheduleCheck();
});

// ---- checking ------------------------------------------------------------------------
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let checkGeneration = 0;

let checkCancellation: monaco.CancellationTokenSource | undefined;

/** Type checks the open file after a pause, replacing a check that has not run yet. */
function requestCheck(delay: number) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(check, delay);
}

/** Type checks the open file after a pause, and keeps the share link in the URL current. */
function scheduleCheck() {
  requestCheck(300);
  history.replaceState(null, "", "#" + encodeState({
    files: projectFiles(),
    features: [...selected],
    active,
    directories: [...directories].sort(),
  }));
  shareLink.hidden = true;
  syncExampleSelect();
}

async function check() {
  const generation = ++checkGeneration;
  const model = models.get(active);
  if (!model) return;
  // an older check still waiting in the worker is skipped there
  checkCancellation?.cancel();
  const cancellation = checkCancellation = new monaco.CancellationTokenSource();
  let diagnostics: DiagnosticInfo[];
  try {
    diagnostics = await client.diagnostics(active, cancellation.token);
  }
  catch (error) {
    if (cancellation.token.isCancellationRequested) return;
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
