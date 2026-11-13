import type { LanguageClient } from "./client";
import { parseProjectConfiguration } from "./configuration";
import * as monaco from "./monaco";
import type { DiagnosticInfo, FeatureDefinition } from "./protocol";
import { setDiagnosticMarkers } from "./providers";

export function createProblemChecker(
  editor: monaco.editor.IStandaloneCodeEditor,
  models: ReadonlyMap<string, monaco.editor.ITextModel>,
  activeFile: () => string,
  openFile: (path: string) => void,
  languageClient: () => LanguageClient,
  definitions: readonly FeatureDefinition[],
  isDirty: (path: string) => boolean,
) {
  const list = document.getElementById("problems")!;
  const count = document.getElementById("problem-count")!;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation: monaco.CancellationTokenSource | undefined;

  async function check(): Promise<void> {
    cancellation?.cancel();
    const fileName = activeFile();
    const model = models.get(fileName);
    if (!model) {
      renderProblems([], fileName);
      return;
    }
    const source = cancellation = new monaco.CancellationTokenSource();
    const token = source.token;
    let diagnostics: DiagnosticInfo[];
    try {
      diagnostics = await languageClient().diagnostics(fileName, token);
    }
    catch (error) {
      diagnostics = [{ message: `Type checking failed: ${(error as Error).message}`, code: 0, category: "error", unnecessary: false, deprecated: false }];
    }
    finally {
      source.dispose();
      if (cancellation === source) cancellation = undefined;
    }
    if (token.isCancellationRequested || fileName !== activeFile() || model.isDisposed()) return;
    const config = models.get("/tsppconfig.json");
    if (config && isDirty("/tsppconfig.json")) {
      diagnostics = diagnostics.filter(diagnostic => diagnostic.fileName !== "/tsppconfig.json");
      diagnostics.push(...parseProjectConfiguration(config.getValue(), definitions).diagnostics);
    }
    for (const [path, projectModel] of models) {
      setDiagnosticMarkers(projectModel, diagnostics.filter(diagnostic => (diagnostic.fileName ?? fileName) === path));
    }
    renderProblems(diagnostics.filter(diagnostic => diagnostic.category !== "suggestion"), fileName);
  }

  function renderProblems(diagnostics: readonly DiagnosticInfo[], fileName: string): void {
    renderProblemList(list, count, diagnostics, fileName,
      (problem, path) => problem.span && models.get(path)?.getPositionAt(problem.span.start),
      (path, position) => {
        openFile(path);
        editor.setPosition(position);
        editor.revealPositionInCenter(position);
        editor.focus();
      });
  }

  return {
    requestCheck(delay: number) {
      clearTimeout(timer);
      timer = setTimeout(check, delay);
    },
    cancelCheck() {
      cancellation?.cancel();
    },
  };
}

function renderProblemList(
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
