// Opens the built playground in a real browser and clicks Run on every example source file. A build
// proves little here: plugins activate in a worker, from a bundle ordered differently from the compiler's own.
// Usage: node scripts/smoke.mjs [example ids...] (after `vite build`). CHROME_PATH names the browser to use.
import { existsSync } from "node:fs";
import process from "node:process";
import { chromium } from "playwright-core";
import { preview } from "vite";

const runTimeout = 180_000;
const browsers = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const executablePath = browsers.find(path => path && existsSync(path));
if (!executablePath) throw new Error(`No browser found; set CHROME_PATH. Looked in: ${browsers.filter(Boolean).join(", ")}`);

const server = await preview({ preview: { port: 4174, strictPort: true }, logLevel: "warn" });
const browser = await chromium.launch({ executablePath });
const failures = [];
try {
  const page = await browser.newPage();
  const errors = [];
  const noteError = text => errors.push(text);
  page.on("pageerror", error => noteError(String(error)));
  // The service worker reloads the page once for cross-origin isolation, so wait until the page settles.
  await page.goto(server.resolvedUrls.local[0], { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelectorAll("#examples option").length > 1, undefined, { timeout: runTimeout });

  const requested = process.argv.slice(2);
  const available = await page.$$eval("#examples option", options => options.map(option => option.value).filter(Boolean));
  const examples = requested.length ? requested : available;
  if (!examples.length) throw new Error("The playground lists no examples.");

  await checkUnsavedDiagnostics(page);

  let fileCount = 0;
  for (const example of examples) {
    errors.length = 0;
    const started = Date.now();
    const result = await runExample(page, example, errors).catch(error => ({ fileCount: 0, reasons: [String(error)] }));
    fileCount += result.fileCount;
    console.log(`${result.reasons.length ? "FAIL" : "ok  "} ${example} (${((Date.now() - started) / 1000).toFixed(1)}s, ${result.fileCount} source file(s))`);
    if (result.reasons.length) failures.push(`${example}:\n  ${result.reasons.join("\n  ")}`);
  }
  console.log(`Checked ${fileCount} source files across ${examples.length} Playground projects.`);
  await checkInvalidMacroEditing(page);
  await checkEditorRecovery(browser);
}
finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  console.error(`\n${failures.length} example(s) failed:\n${failures.join("\n")}`);
  process.exit(1);
}
process.exit(0);

async function checkUnsavedDiagnostics(page) {
  page.once("dialog", dialog => dialog.accept("diagnostics-smoke.tspp"));
  await page.getByRole("button", { name: "New file" }).click();
  const editor = page.locator("#editor .monaco-editor");
  const problem = page.locator("#problems .problem-message").filter({ hasText: "TS2322" });
  const write = async source => {
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(source);
  };
  const save = async () => {
    await page.keyboard.press("Control+s");
    await page.locator("#outputs-status").filter({ hasText: /^Up to date$/ }).waitFor();
  };
  const runAndCheck = async expected => {
    const errors = await runActiveFile(page);
    if (errors.length) throw new Error(errors.join(" | "));
    await page.locator("#run-output").getByText(expected, { exact: true }).waitFor();
  };

  await write('console.log("saved-output");');
  await save();
  await write('const value: number = "draft-output"; console.log(value);');
  await problem.waitFor();
  await editor.locator(".squiggly-error").first().waitFor();
  await page.locator("#output-editor .view-lines").getByText("saved-output", { exact: false }).first().waitFor();
  await runAndCheck("saved-output");

  await editor.locator(".view-lines").click();
  await write('const value: string = "draft-output"; console.log(value);');
  await problem.waitFor({ state: "hidden" });
  await save();
  await runAndCheck("draft-output");
  console.log("ok   unsaved diagnostics and saved outputs");
}

async function checkInvalidMacroEditing(page) {
  await page.selectOption("#examples", "13-macros");
  await page.locator('#project-tree [data-path="/src/02-transform.tspp"]').click();
  const editor = page.locator("#editor .monaco-editor");
  await editor.locator(".view-lines").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(`import type { MacroContext } from "ts-plus-plus/plugins/macros/sdk";
interface Box {}
macro function exposeTypeName([], { factory }: MacroContext) {
  const declaration = factory
    .createVariableDeclaration(
      "BoxTypeName", undefined, undefined,
      "aaa",
    );
  return factory.createVariableStatement(undefined, factory.createVariableDeclarationList([declaration]));
}
macro exposeTypeName(Box);`);

  const problem = page.locator("#problems .problem").filter({ hasText: "TS2345" });
  await problem.locator(".problem-location").filter({ hasText: "src/02-transform.tspp:7:" }).waitFor();
  await problem.locator(".problem-message").filter({ hasText: "MacroNode" }).waitFor();
  await page.locator("#problems .problem").filter({ hasText: "Macro 'exposeTypeName' returned an invalid syntax tree" }).waitFor();
  await editor.locator(".squiggly-error").first().waitFor();
  await problem.click();
  await page.keyboard.press("Control+Shift+Space");
  await page.locator(".parameter-hints-widget").filter({ hasText: "initializer?: MacroNode" }).waitFor();
  await page.keyboard.press("Escape");
  // Target the rendered method itself: hover should not depend on the caret or keyboard-chord state left by signature help.
  const method = editor.locator(".view-line span").filter({ hasText: /\bcreateVariableDeclaration\b/ }).last();
  await method.hover();
  await page.locator(".monaco-hover").filter({ hasText: "initializer?: MacroNode" }).waitFor().catch(async error => {
    console.error("Macro method hover contents:", await page.locator(".monaco-hover").allTextContents());
    throw error;
  });
  await page.keyboard.press("Escape");
  await method.click();
  await page.keyboard.press("Control+Space");
  await page.locator(".suggest-widget").getByText("createVariableDeclaration", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  console.log("ok   macro argument diagnostics, hover, signature help, and completions");
}

async function checkEditorRecovery(browser) {
  const page = await browser.newPage();
  try {
    // Inject the RPC errors produced by a crashing compiler hook, only in the worker with that plugin enabled.
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        #hasOperatorSections = false;
        #broken = false;

        postMessage(message, ...options) {
          if (message.method === "setProject") {
            this.#hasOperatorSections = message.args[1].includes("operator-sections");
            this.#broken = Object.values(message.args[0]).some(text => text.includes("/* crash */"));
          }
          if (message.method === "editFile") this.#broken = message.args[1].includes("/* crash */");
          if (this.#hasOperatorSections && this.#broken && ["diagnostics", "quickInfo", "completions", "completionDetails", "signatureHelp"].includes(message.method)) {
            queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", {
              data: { id: message.id, error: "Simulated operator-sections compiler failure" },
            })));
            return;
          }
          super.postMessage(message, ...options);
        }
      };
    });
    await page.goto(server.resolvedUrls.local[0], { waitUntil: "load" });
    await page.selectOption("#examples", "02-operator-sections");
    await page.locator("#editor .view-lines").click();
    const write = async source => {
      await page.keyboard.press("Control+a");
      await page.keyboard.insertText(source);
    };
    const showHover = async expected => {
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Control+k");
      await page.keyboard.press("Control+i");
      await page.locator(".monaco-hover").filter({ hasText: expected }).waitFor();
      await page.keyboard.press("Escape");
    };
    await write("/* crash */\nconst sample = { alpha: 1 };\nsample.alpha");
    const problem = page.locator("#problems .problem-message").filter({ hasText: "Type checking failed: Simulated operator-sections compiler failure" });
    await problem.waitFor();
    await showHover("(property) alpha: number");
    await page.keyboard.press("Control+Space");
    await page.locator(".suggest-widget").getByText("alpha", { exact: true }).waitFor();
    await page.keyboard.press("Escape");

    await write('/* crash */\nconst sample = { alpha: "latest draft" };\nsample.alpha');
    await showHover("(property) alpha: string");
    await write("/* crash */\nfunction format(value: number) { return String(value); }\nformat(");
    await page.keyboard.press("Control+Shift+Space");
    await page.locator(".parameter-hints-widget").filter({ hasText: "value: number" }).waitFor();
    await page.keyboard.press("Escape");
    await write("const isPositive = (_ > 0);\nisPositive");
    await problem.waitFor({ state: "hidden" });
    await showHover(/const isPositive: \(.*\) => boolean/);
    console.log("ok   editor recovery after a plugin compiler exception and after fixing the draft");
  }
  finally {
    await page.close();
  }
}

/** Selects an example project and runs all its source files. */
async function runExample(page, example, errors) {
  await page.evaluate(() => {
    const status = document.getElementById("analysis-status");
    window.__tsppAnalysisObserver?.disconnect();
    window.__tsppAnalysisStatuses = [];
    const record = () => status.textContent && window.__tsppAnalysisStatuses.push(status.textContent);
    window.__tsppAnalysisObserver = new MutationObserver(record);
    window.__tsppAnalysisObserver.observe(status, { childList: true, characterData: true, subtree: true });
  });
  await page.selectOption("#examples", example);
  const reasons = [];
  // Macros expand in the background: every built-in output must catch up with them. Declaration views are an
  // explicit Playground request even when the example's real tsconfig disables emit or does not enable declarations.
  for (const category of ["javascript", "dts", "dtspp"]) {
    await page.click(`#output-tabs [data-category="${category}"]`);
    await page.waitForFunction(() => document.getElementById("outputs-status").textContent === "Up to date", undefined, { timeout: 10_000 })
      .catch(async () => reasons.push(`${category} output stayed at: ${await page.textContent("#outputs-status")}`));
  }
  // Loading a project expands every directory. The example tree includes resources such as tsconfig.json.
  const sourceFiles = await page.locator("#project-tree .tree-row:not([aria-expanded])").filter({
    has: page.locator(".file-name", { hasText: /\.(?:tspp|ts)$/ }),
  }).all();
  if (!sourceFiles.length) reasons.push("the project tree lists no source files");
  for (const file of sourceFiles) {
    const path = await file.getAttribute("data-path");
    await file.click();
    const runFailures = await runActiveFile(page).catch(error => [String(error)]);
    reasons.push(...runFailures.map(reason => `${path}: ${reason}`));
    if (example === "11-algebraic-effects" && path === "/src/02-suspension.tspp" && !runFailures.length) {
      const output = (await page.locator("#run-output .runtime-log").allTextContents()).map(line => line.trimEnd());
      // Logged only once both suspended computations have resumed from their timers and settled.
      const expected = [
        `[02-suspension] ${JSON.stringify({ batchResults: ["item-1@1", "item-2@2", "item-3@3"], recoveredResult: "recovered:timeout" }, undefined, 2)}`,
      ];
      if (output.length !== expected.length || expected.some((line, index) => output[index] !== line)) {
        reasons.push(`${path}: expected ${JSON.stringify(expected)} before exit, got ${JSON.stringify(output)}`);
      }
    }
    const problems = await page.locator("#problems .problem-message").allTextContents();
    reasons.push(...problems.filter(problem => problem.startsWith("Type checking failed")).map(problem => `${path}: ${problem}`));
  }
  if (example === "12-formal-verification") {
    const statuses = await page.evaluate(() => window.__tsppAnalysisStatuses);
    if (!statuses.some(text => /^Downloading Z3 — first use may be slow… (?:\d+%|\d+\.\d MB)$/.test(text))) {
      reasons.push(`Z3 download progress was not shown: ${statuses.join(" | ")}`);
    }
  }
  if (errors.length) reasons.push(`the page threw: ${errors.join(" | ")}`);
  return { fileCount: sourceFiles.length, reasons };
}

async function runActiveFile(page) {
  await page.waitForFunction(() => !document.getElementById("run-javascript").disabled, undefined, { timeout: runTimeout });
  await page.click("#run-javascript");
  // Run reports its end in the status: success, an exception, or that it could not generate JavaScript.
  await page.waitForFunction(() => {
    const status = document.getElementById("run-status");
    return !status.classList.contains("loading") && !/^(Running|Generating|Source changed)/.test(status.textContent ?? "");
  }, undefined, { timeout: runTimeout });
  const status = (await page.textContent("#run-status")) ?? "";
  const output = await page.$$eval("#run-output .runtime-error", lines => lines.map(line => line.textContent));
  const reasons = [];
  if (status !== "Exited successfully") reasons.push(`run ended with: ${status}`);
  if (output.length) reasons.push(`it logged errors: ${output.join(" | ")}`);
  return reasons;
}
