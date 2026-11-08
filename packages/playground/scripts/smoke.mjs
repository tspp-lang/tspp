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
