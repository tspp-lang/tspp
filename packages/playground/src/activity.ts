export type ActivityKind = "boot" | "artifact" | "macro" | "smt" | "run";

export interface ActivityHandle {
  update(detail: string): void;
  finish(): void;
}

export interface ActivityController {
  start(
    kind: ActivityKind,
    title: string,
    detail: string,
    action?: { readonly label: string; readonly run: () => void },
  ): ActivityHandle;
}

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Renders the newest outstanding task in the shared activity rail. */
export function createActivityController(): ActivityController {
  const bar = element("activity-bar");
  const title = element("activity-title");
  const detail = element("activity-detail");
  const action = element<HTMLButtonElement>("activity-action");
  const tasks: {
    readonly id: number;
    readonly kind: ActivityKind;
    readonly title: string;
    detail: string;
    readonly action?: { readonly label: string; readonly run: () => void };
  }[] = [];
  let nextId = 1;

  function render(): void {
    const task = tasks.at(-1);
    bar.hidden = !task;
    if (!task) return;
    bar.dataset.kind = task.kind;
    title.textContent = task.title;
    detail.textContent = task.detail;
    action.hidden = !task.action;
    action.textContent = task.action?.label ?? "";
    action.onclick = task.action?.run ?? null;
  }

  return {
    start(kind, taskTitle, taskDetail, taskAction) {
      const task = { id: nextId++, kind, title: taskTitle, detail: taskDetail, action: taskAction };
      tasks.push(task);
      render();
      return {
        update(nextDetail) {
          task.detail = nextDetail;
          if (tasks.at(-1) === task) render();
        },
        finish() {
          const index = tasks.findIndex(candidate => candidate.id === task.id);
          if (index >= 0) tasks.splice(index, 1);
          render();
        },
      };
    },
  };
}
