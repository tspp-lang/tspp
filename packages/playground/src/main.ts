import examples from "virtual:tspp-examples";
import { startLanguageWorker } from "./client";
import { defaultConfiguration, parseProjectConfiguration, setFeatureInConfiguration } from "./configuration";
import { z3Location } from "./deployment";
import { effectiveFeatures, renderFeaturePanel } from "./features";
import { jsoncLanguageId, registerJsoncLanguage } from "./jsoncLanguage";
import * as monaco from "./monaco";
import { createOutputController } from "./outputs";
import { renderProblemList } from "./problems";
import { addParentDirectories, baseName, normalizedPath, parentDirectory, renderProjectTree as renderTree, replacePathPrefix, validItemName } from "./projectTree";
import type { DiagnosticInfo, ProjectFiles } from "./protocol";
import { registerProviders, setDiagnosticMarkers } from "./providers";
import { decodeState, encodeState, onSharedStateChange, type SharedState } from "./share";
import { registerSmtLanguage } from "./smtLanguage";
import { renderSolverStatus } from "./solverStatus";
import { languageId, registerTsppLanguage } from "./tsppLanguage";
import { renderEditorTabs, setupHorizontalResizer, setupProjectSelector, setupSaveShortcut, setupShareButton } from "./workspaceUi";

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
  else renderSolverStatus(analysisStatus, event);
});
registerTsppLanguage();
registerJsoncLanguage();
registerSmtLanguage();
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
  initialization = await client.init(await z3Location());
}
catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = "Compiler failed to load";
  bootOverlay.classList.add("failed");
  bootDetail.textContent = `Could not start the compiler: ${message}`;
  throw error;
}
const { features: definitions } = initialization;
outputs.addFeatureOutputs(definitions);
status.textContent = `TS++ ${__TSPP_VERSION__}`;
bootOverlay.hidden = true;

// ---- project ---------------------------------------------------------------------------
const models = new Map<string, monaco.editor.ITextModel>();
const savedContents = new Map<string, string>();
const resources = new Map<string, string>();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState | null>();
let openFiles: string[] = [];
const directories = new Set<string>();
const expandedDirectories = new Set<string>();
const selected = new Set<string>();
let active = "";
let selectedProjectItem = "";

const currentFeatures = () => effectiveFeatures(definitions, selected);
const isSourceFile = (path: string) => /\.(tspp|ts)$/.test(path);
const isEditorFile = (path: string) => isSourceFile(path) || path.endsWith(".json");
const projectFiles = (): ProjectFiles => Object.fromEntries([...resources, ...savedContents]);
const isDirty = (path: string) => models.get(path)?.getValue() !== savedContents.get(path);
const dirtyFiles = () => new Set([...models.keys()].filter(isDirty));

function createProjectModel(path: string, text: string): monaco.editor.ITextModel {
  const model = monaco.editor.createModel(text, path.endsWith(".json") ? jsoncLanguageId : isSourceFile(path) ? languageId : "plaintext", monaco.Uri.file(path));
  model.onDidChangeContent(() => {
    checkGeneration++;
    checkCancellation?.cancel();
    setDiagnosticMarkers(model, []);
    renderTabs();
    if (path === active) outputs.setDirty(isDirty(path));
    exampleSelect.value = "";
  });
  return model;
}

async function applyConfiguration(): Promise<void> {
  const text = savedContents.get("/tsconfig.json");
  if (text === undefined) return;
  const configuration = parseProjectConfiguration(text, definitions);
  selected.clear();
  configuration.features.forEach(id => selected.add(id));
  refreshFeatures();
  outputs.setRunBlock(configuration.runBlockReason);
  await client.setProject(projectFiles(), currentFeatures());
}

function loadProject(state: SharedState) {
  editor.setModel(null);
  active = "";
  for (const model of models.values()) model.dispose();
  models.clear();
  savedContents.clear();
  resources.clear();
  viewStates.clear();
  openFiles = [];
  directories.clear();
  expandedDirectories.clear();
  const stateFiles = state.files["/tsconfig.json"]
    ? state.files
    : { ...state.files, "/tsconfig.json": defaultConfiguration(state.features, definitions) };
  for (const [path, text] of Object.entries(stateFiles)) {
    addParentDirectories(path, directories);
    if (!isEditorFile(path)) {
      resources.set(path, text);
      continue;
    }
    savedContents.set(path, text);
    models.set(path, createProjectModel(path, text));
  }
  state.directories?.map(normalizedPath).filter(path => path !== "/").forEach(path => directories.add(path));
  directories.forEach(path => expandedDirectories.add(path));
  selectedProjectItem = state.active;
  openFiles = [...new Set([...(state.open ?? []), state.active])].filter(path => models.has(path));
  void applyConfiguration();
  outputs.markStale();
  renderTabs();
  renderProjectTree();
  openFile(state.active, true);
}

function openFile(path: string, refreshOutput = false) {
  const model = models.get(path);
  if (!model) return;
  if (!openFiles.includes(path)) openFiles.push(path);
  if (active && models.has(active)) viewStates.set(active, editor.saveViewState());
  active = path;
  outputs.setFile(path, refreshOutput, isSourceFile(path));
  outputs.setDirty(isDirty(path));
  editor.setModel(model);
  const viewState = viewStates.get(path);
  if (viewState) editor.restoreViewState(viewState);
  renderTabs();
  selectedProjectItem = path;
  renderProjectTree();
  scheduleCheck();
}

function renderTabs() {
  renderEditorTabs(tabBar, openFiles.filter(path => models.has(path)), active, dirtyFiles(), openFile, closeFile);
}

function closeFile(path: string): void {
  const index = openFiles.indexOf(path);
  if (index < 0) return;
  if (isDirty(path)) {
    if (!confirm(`Discard the unsaved changes in ${baseName(path)} and close it?`)) return;
    models.get(path)?.setValue(savedContents.get(path) ?? "");
  }
  openFiles.splice(index, 1);
  if (active !== path) {
    renderTabs();
    scheduleCheck();
    return;
  }
  const next = openFiles[Math.min(index, openFiles.length - 1)];
  if (next) {
    openFile(next);
    return;
  }
  if (active && models.has(active)) viewStates.set(active, editor.saveViewState());
  active = "";
  editor.setModel(null);
  outputs.setFile("", true, false);
  renderTabs();
  renderProjectTree();
  scheduleCheck();
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
  return models.has(selectedProjectItem) || resources.has(selectedProjectItem) ? parentDirectory(selectedProjectItem) : directories.has("/src") ? "/src" : "/";
}

const projectPathExists = (path: string) => directories.has(path) || models.has(path) || resources.has(path);

function syncProjectChange(nextActive = active): void {
  void client.setProject(projectFiles(), currentFeatures());
  outputs.markStale();
  renderTabs();
  renderProjectTree();
  openFile(models.has(nextActive) ? nextActive : models.keys().next().value!, true);
}

async function saveProject(): Promise<void> {
  const dirty = dirtyFiles();
  for (const path of dirty) savedContents.set(path, models.get(path)!.getValue());
  renderTabs();
  await applyConfiguration();
  if (active) outputs.setFile(active, true, isSourceFile(active));
  outputs.setDirty(active ? isDirty(active) : false);
  scheduleCheck();
}

setupSaveShortcut(() => void saveProject());

function createFile(): void {
  const name = validItemName(prompt("New source file name", "untitled.tspp"));
  if (!name) return;
  if (!isSourceFile(name)) {
    alert("Source files must end in .tspp or .ts.");
    return;
  }
  const path = normalizedPath(`${selectedDirectory()}/${name}`);
  if (projectPathExists(path)) {
    alert(`${path} already exists.`);
    return;
  }
  addParentDirectories(path, directories);
  savedContents.set(path, "");
  models.set(path, createProjectModel(path, ""));
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

function renameSelectedItem(): void {
  const oldPath = selectedProjectItem;
  if (!projectPathExists(oldPath)) return;
  if (oldPath === "/tsconfig.json") {
    alert("tsconfig.json is the Playground project's configuration source and cannot be renamed.");
    return;
  }
  const directory = directories.has(oldPath);
  const name = validItemName(prompt(`Rename ${baseName(oldPath)}`, baseName(oldPath)));
  if (!name || name === baseName(oldPath)) return;
  if (!directory && isSourceFile(oldPath) && !isSourceFile(name)) {
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
      const movedPath = replacePathPrefix(path, oldPath, nextPath);
      const text = model.getValue();
      const saved = savedContents.get(path) ?? text;
      model.dispose();
      models.delete(path);
      savedContents.delete(path);
      savedContents.set(movedPath, saved);
      models.set(movedPath, createProjectModel(movedPath, text));
      const viewState = viewStates.get(path);
      if (viewState) viewStates.set(movedPath, viewState);
      viewStates.delete(path);
    }
    for (const [path, text] of movedResources) {
      resources.delete(path);
      resources.set(replacePathPrefix(path, oldPath, nextPath), text);
    }
    const movedDirectories = [...directories].filter(path => path === oldPath || path.startsWith(`${oldPath}/`));
    for (const path of movedDirectories) directories.delete(path);
    movedDirectories.forEach(path => directories.add(replacePathPrefix(path, oldPath, nextPath)));
    const movedExpanded = [...expandedDirectories].filter(path => path === oldPath || path.startsWith(`${oldPath}/`));
    for (const path of movedExpanded) expandedDirectories.delete(path);
    movedExpanded.forEach(path => expandedDirectories.add(replacePathPrefix(path, oldPath, nextPath)));
    if (active.startsWith(`${oldPath}/`)) active = replacePathPrefix(active, oldPath, nextPath);
    openFiles = openFiles.map(path => path.startsWith(`${oldPath}/`) ? replacePathPrefix(path, oldPath, nextPath) : path);
  }
  else if (models.has(oldPath)) {
    const oldModel = models.get(oldPath)!;
    const text = oldModel.getValue();
    const saved = savedContents.get(oldPath) ?? text;
    oldModel.dispose();
    models.delete(oldPath);
    savedContents.delete(oldPath);
    savedContents.set(nextPath, saved);
    models.set(nextPath, createProjectModel(nextPath, text));
    const viewState = viewStates.get(oldPath);
    if (viewState) viewStates.set(nextPath, viewState);
    viewStates.delete(oldPath);
    if (active === oldPath) active = nextPath;
    openFiles = openFiles.map(path => path === oldPath ? nextPath : path);
  }
  else {
    const text = resources.get(oldPath)!;
    resources.delete(oldPath);
    resources.set(nextPath, text);
  }
  addParentDirectories(nextPath, directories);
  selectedProjectItem = nextPath;
  syncProjectChange(active);
}

function deleteSelectedProjectItem(): void {
  const path = selectedProjectItem;
  if (!projectPathExists(path)) return;
  if (path === "/tsconfig.json") {
    alert("tsconfig.json is required because it is the Playground project's configuration source.");
    return;
  }
  const directory = directories.has(path);
  const sourceFiles = [...models.keys()].filter(isSourceFile);
  const affectedModels = [...models.keys()].filter(file => file === path || directory && file.startsWith(`${path}/`));
  const affectedSources = affectedModels.filter(isSourceFile);
  if (sourceFiles.length - affectedSources.length < 1) {
    alert("A playground project must keep at least one source file.");
    return;
  }
  if (!confirm(`Delete ${directory ? "folder" : "file"} ${baseName(path)}${directory ? " and its contents" : ""}?`)) return;
  for (const file of affectedModels) {
    models.get(file)?.dispose();
    models.delete(file);
    savedContents.delete(file);
    viewStates.delete(file);
  }
  openFiles = openFiles.filter(file => !affectedModels.includes(file));
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

setupHorizontalResizer(element("project-resizer"), element("source-workspace"));

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

/** Shows the example name while the project is still exactly that example. */
function syncExampleSelect() {
  const files = projectFiles();
  const matching = examples.find(example =>
    Object.keys(example.files).length === Object.keys(files).length && Object.entries(example.files).every(([path, text]) => files[path] === text)
  );
  exampleSelect.value = matching?.id ?? "";
}
setupProjectSelector(exampleSelect, () => exampleState(exampleSelect.value), loadProject, () => dirtyFiles().size > 0, syncExampleSelect);

// ---- features ------------------------------------------------------------------------
const refreshFeatures = renderFeaturePanel(featureList, definitions, () => selected, (name, checked) => {
  const definition = definitions.find(candidate => candidate.id === name);
  const configModel = models.get("/tsconfig.json");
  if (!definition || !configModel) return;
  const text = setFeatureInConfiguration(configModel.getValue(), definition, checked);
  if (text === undefined) {
    alert("Fix the errors in tsconfig.json before changing Features from the shortcut panel.");
    return;
  }
  configModel.setValue(text);
  if (!openFiles.includes("/tsconfig.json")) openFiles.push("/tsconfig.json");
  renderTabs();
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

/** Type checks the saved open file after a pause, and keeps the saved project URL current. */
function scheduleCheck() {
  if (!active || !isDirty(active)) requestCheck(300);
  history.replaceState(null, "", "#" + encodeState({
    files: projectFiles(),
    features: [...selected],
    active,
    open: openFiles,
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
  for (const [path, projectModel] of models) {
    const forModel = diagnostics.filter(diagnostic => (diagnostic.fileName ?? active) === path);
    setDiagnosticMarkers(projectModel, forModel);
  }
  renderProblems(diagnostics.filter(d => d.category !== "suggestion"));
}

function renderProblems(problems: readonly DiagnosticInfo[]) {
  renderProblemList(problemList, problemCount, problems, active,
    (problem, fileName) => problem.span && models.get(fileName)?.getPositionAt(problem.span.start),
    (fileName, position) => {
      openFile(fileName);
      editor.setPosition(position);
      editor.revealPositionInCenter(position);
      editor.focus();
    });
}

loadProject(decodeState(location.hash) ?? exampleState(examples[0].id)!);

// A pasted share link in the same tab only changes the hash.
onSharedStateChange(state => {
  if (dirtyFiles().size && !confirm("Discard all unsaved changes and open the shared project?")) {
    scheduleCheck();
    return;
  }
  loadProject(state);
});

setupShareButton(shareButton, shareLink);
