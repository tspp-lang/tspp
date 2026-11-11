/** Per-viewer playground preferences, kept in this browser only and never in share links. */

export interface PlaygroundSettings {
  /** Format every changed source file before Ctrl+S saves it. */
  formatOnSave: boolean;
}

const storageKey = "tspp-playground-settings";
const defaults: PlaygroundSettings = { formatOnSave: false };

function loadSettings(): PlaygroundSettings {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Partial<PlaygroundSettings>;
    return { formatOnSave: typeof stored.formatOnSave === "boolean" ? stored.formatOnSave : defaults.formatOnSave };
  }
  catch {
    return { ...defaults };
  }
}

function storeSettings(settings: PlaygroundSettings): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  }
  catch {
    // Storage can be unavailable (private windows, blocked site data); the setting then lasts for this page.
  }
}

/** Wires the header's settings button to its panel and returns the live settings. */
export function setupSettings(button: HTMLButtonElement, panel: HTMLElement): Readonly<PlaygroundSettings> {
  const settings = loadSettings();
  const formatOnSave = panel.querySelector<HTMLInputElement>("#format-on-save")!;
  formatOnSave.checked = settings.formatOnSave;
  formatOnSave.onchange = () => {
    settings.formatOnSave = formatOnSave.checked;
    storeSettings(settings);
  };

  const setOpen = (open: boolean) => {
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
  };
  button.onclick = () => setOpen(button.getAttribute("aria-expanded") !== "true");
  document.addEventListener("pointerdown", event => {
    if (!panel.hidden && !panel.contains(event.target as Node) && !button.contains(event.target as Node)) setOpen(false);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      button.focus();
    }
  });
  return settings;
}
