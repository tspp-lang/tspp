import type { DiagnosticInfo } from "./protocol";

export function renderProblemList(
  container: HTMLElement,
  count: HTMLElement,
  problems: readonly DiagnosticInfo[],
  active: string,
  locate: (problem: DiagnosticInfo, fileName: string) => { lineNumber: number; column: number } | undefined,
  open: (fileName: string, position: { lineNumber: number; column: number }) => void,
): void {
  count.textContent = String(problems.length);
  container.replaceChildren(...problems.map(problem => {
    const item = document.createElement("li");
    item.className = `problem ${problem.category}`;
    const location = document.createElement("span");
    location.className = "problem-location";
    const message = document.createElement("span");
    message.className = "problem-message";
    message.textContent = problem.code ? `${problem.message} (TS${problem.code})` : problem.message;
    const fileName = problem.fileName ?? active;
    const position = locate(problem, fileName);
    if (position) {
      location.textContent = `${fileName.replace(/^\//, "")}:${position.lineNumber}:${position.column}`;
      item.onclick = () => open(fileName, position);
    }
    item.append(location, message);
    return item;
  }));
}
