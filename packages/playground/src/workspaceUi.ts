export function renderEditorTabs(
  tabBar: HTMLElement,
  paths: readonly string[],
  active: string,
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
    tab.setAttribute("aria-selected", String(path === active));
    const label = document.createElement("span");
    label.className = "tab-label";
    label.textContent = path.slice(1);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.setAttribute("aria-label", `Close ${path.slice(1)}`);
    close.title = "Close";
    close.textContent = "×";
    close.onclick = event => {
      event.stopPropagation();
      onClose(path);
    };
    tab.append(label, close);
    tab.onclick = () => onOpen(path);
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
