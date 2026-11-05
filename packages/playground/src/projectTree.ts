export const normalizedPath = (path: string) => `/${path.replaceAll("\\", "/").split("/").filter(Boolean).join("/")}`;
export const parentDirectory = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

interface TreeEntry {
  readonly path: string;
  readonly directory: boolean;
}

export interface ProjectTreeState {
  readonly directories: ReadonlySet<string>;
  readonly expandedDirectories: ReadonlySet<string>;
  readonly files: ReadonlyMap<string, boolean>;
  readonly active: string;
  readonly selected: string;
}

function projectEntries(state: ProjectTreeState, parent: string): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const path of state.directories) {
    if (parentDirectory(path) === parent) entries.push({ path, directory: true });
  }
  for (const path of state.files.keys()) {
    if (parentDirectory(path) === parent) entries.push({ path, directory: false });
  }
  return entries.sort((left, right) => Number(right.directory) - Number(left.directory)
    || baseName(left.path).localeCompare(baseName(right.path)));
}

/** Rebuilds the project explorer and reports whether its selected item still exists. */
export function renderProjectTree(
  container: HTMLElement,
  state: ProjectTreeState,
  onSelect: (path: string, directory: boolean) => void,
): boolean {
  const fragment = document.createDocumentFragment();
  const renderEntries = (parent: string, depth: number): void => {
    for (const entry of projectEntries(state, parent)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tree-row";
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.style.setProperty("--tree-depth", String(depth));
      row.dataset.path = entry.path;
      row.classList.toggle("selected", state.selected === entry.path);
      row.classList.toggle("active", state.active === entry.path);
      const twist = document.createElement("span");
      twist.className = "tree-twist codicon";
      const icon = document.createElement("span");
      icon.className = "codicon";
      if (entry.directory) {
        const expanded = state.expandedDirectories.has(entry.path);
        row.setAttribute("aria-expanded", String(expanded));
        twist.classList.add(expanded ? "codicon-chevron-down" : "codicon-chevron-right");
        icon.classList.add(expanded ? "codicon-folder-opened" : "codicon-folder");
      }
      else {
        const editable = state.files.get(entry.path) ?? false;
        twist.classList.add("codicon-blank");
        icon.classList.add(entry.path.endsWith(".json") ? "codicon-json" : "codicon-file-code");
        row.classList.toggle("resource", !editable);
        if (!editable) row.title = "Project resource (not editable in the playground)";
      }
      const name = document.createElement("span");
      name.className = "file-name";
      name.textContent = baseName(entry.path);
      row.append(twist, icon, name);
      row.onclick = () => onSelect(entry.path, entry.directory);
      fragment.append(row);
      if (entry.directory && state.expandedDirectories.has(entry.path)) renderEntries(entry.path, depth + 1);
    }
  };
  renderEntries("/", 0);
  container.replaceChildren(fragment);
  return state.directories.has(state.selected) || state.files.has(state.selected);
}
