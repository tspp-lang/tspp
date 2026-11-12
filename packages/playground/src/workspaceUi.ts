import * as monaco from "./monaco";

/** The source editor, in the light or dark theme the system asks for. */
export function createSourceEditor(container: HTMLElement): monaco.editor.IStandaloneCodeEditor {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  dark.addEventListener("change", () => monaco.editor.setTheme(dark.matches ? "vs-dark" : "vs"));
  return monaco.editor.create(container, {
    model: null,
    theme: dark.matches ? "vs-dark" : "vs",
    automaticLayout: true,
    minimap: { enabled: false },
    fontSize: 14,
    scrollBeyondLastLine: false,
    fixedOverflowWidgets: true,
    // The theme's colours are page CSS variables, which do not reach menus rendered in a shadow root.
    useShadowDOM: false,
  });
}

export function renderEditorTabs(
  tabBar: HTMLElement,
  paths: readonly string[],
  active: string,
  dirty: ReadonlySet<string>,
  onOpen: (path: string) => void,
  onClose: (path: string) => void,
): void {
  tabBar.hidden = paths.length === 0;
  tabBar.replaceChildren(...paths.map(path => {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.dataset.path = path;
    tab.role = "tab";
    tab.tabIndex = 0;
    tab.title = path.slice(1);
    tab.classList.toggle("active", path === active);
    tab.classList.toggle("dirty", dirty.has(path));
    tab.setAttribute("aria-selected", String(path === active));
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = path.slice(1);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.setAttribute("aria-label", `Close ${path.slice(1)}`);
    close.title = "Close";
    close.textContent = dirty.has(path) ? "●" : "×";
    close.onclick = event => {
      event.stopPropagation();
      onClose(path);
    };
    tab.append(label, close);
    tab.onclick = () => onOpen(path);
    // Pressing the middle button over the scrollable tab bar starts autoscroll where the browser has it, and then no auxclick follows.
    tab.onmousedown = event => {
      if (event.button === 1) event.preventDefault();
    };
    tab.onauxclick = event => event.button === 1 && onClose(path);
    tab.onkeydown = event => {
      if (event.key === "Enter" || event.key === " ") onOpen(path);
      else if (event.key === "Delete") onClose(path);
    };
    return tab;
  }));
}

export function setupHorizontalResizer(resizer: HTMLElement, workspace: HTMLElement): void {
  resizer.onpointerdown = event => {
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("dragging");
  };
  resizer.onpointermove = event => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    const width = Math.max(160, Math.min(360, event.clientX - workspace.getBoundingClientRect().left));
    workspace.style.setProperty("--project-width", `${width}px`);
  };
  resizer.onpointerup = event => {
    resizer.releasePointerCapture(event.pointerId);
    resizer.classList.remove("dragging");
  };
  resizer.onkeydown = event => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const current = Number.parseFloat(getComputedStyle(workspace).getPropertyValue("--project-width")) || 220;
    const next = Math.max(160, Math.min(360, current + (event.key === "ArrowLeft" ? -10 : 10)));
    workspace.style.setProperty("--project-width", `${next}px`);
    event.preventDefault();
  };
}

export function setupSaveShortcut(save: () => void): void {
  window.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    save();
  }, { capture: true });
  window.addEventListener("beforeunload", event => {
    event.preventDefault();
    // Required by older Chromium/WebKit versions; modern browsers ignore the value and show their own wording.
    event.returnValue = "";
  });
}

export function setupShareButton(button: HTMLButtonElement, manualLink: HTMLInputElement): void {
  button.onclick = async () => {
    const href = location.href;
    try {
      await navigator.clipboard.writeText(href);
    }
    catch {
      manualLink.value = href;
      manualLink.hidden = false;
      manualLink.select();
      return;
    }
    button.textContent = "Link copied";
    setTimeout(() => button.textContent = "Share", 1500);
  };
}

export function setupProjectSelector<T>(
  select: HTMLSelectElement,
  selectedState: () => T | undefined,
  load: (state: T) => void,
  hasUnsavedChanges: () => boolean,
  restoreSelection: () => void,
): void {
  select.onchange = () => {
    const state = selectedState();
    if (!state) return;
    if (hasUnsavedChanges() && !confirm("Discard all unsaved changes and open another example?")) {
      restoreSelection();
      return;
    }
    load(state);
  };
}
