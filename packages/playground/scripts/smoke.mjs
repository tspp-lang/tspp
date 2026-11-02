// Opens the built playground in a real browser and runs every example's JavaScript, which is what its users do. A build
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

  for (const example of examples) {
    errors.length = 0;
    const started = Date.now();
    const failure = await runExample(page, example, errors).catch(error => String(error));
    const lines = await page.$$eval("#run-output > *", output => output.length);
    console.log(`${failure ? "FAIL" : "ok  "} ${example} (${((Date.now() - started) / 1000).toFixed(1)}s, ${lines} line(s) of output)`);
    if (failure) failures.push(`${example}: ${failure}`);
  }
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

/** Selects an example and runs it; returns why it failed, if it did. */
async function runExample(page, example, errors) {
  await page.selectOption("#examples", example);
  await page.waitForFunction(() => !document.getElementById("run-javascript").disabled, undefined, { timeout: runTimeout });
  await page.click("#run-javascript");
  // Run reports its end in the status: success, an exception, or that it could not generate JavaScript.
  await page.waitForFunction(() => {
    const status = document.getElementById("run-status");
    return !status.classList.contains("loading") && !/^(Running|Generating|Source changed)/.test(status.textContent ?? "");
  }, undefined, { timeout: runTimeout });
  const status = (await page.textContent("#run-status")) ?? "";
  const output = await page.$$eval("#run-output .runtime-error", lines => lines.map(line => line.textContent));
  const problems = await page.$$eval("#problems .problem-message", items => items.map(item => item.textContent));
  const reasons = [];
  if (status !== "Exited successfully") reasons.push(`run ended with: ${status}`);
  if (output.length) reasons.push(`it logged errors: ${output.join(" | ")}`);
  const crashes = problems.filter(problem => problem?.startsWith("Type checking failed"));
  if (crashes.length) reasons.push(crashes.join(" | "));
  if (errors.length) reasons.push(`the page threw: ${errors.join(" | ")}`);
  return reasons.join("; ") || undefined;
}
