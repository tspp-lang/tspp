// Runs every feature plugin's own test suite with all feature plugins loaded, to catch implicit interference between them.
// "插件间关系": implicit interference). One plugin at a time, in a single process each, to keep memory bounded.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const pluginsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "plugins");
const skipped = new Set(["integration", "test-support"]);
const failed = [];
for (const name of fs.readdirSync(pluginsDirectory).sort()) {
    const testDirectory = path.join(pluginsDirectory, name, "test");
    if (skipped.has(name) || !fs.existsSync(testDirectory)) continue;
    const files = fs.readdirSync(testDirectory).filter(file => file.endsWith(".test.cjs")).map(file => path.join("test", file));
    console.log(`\n== ${name} (all plugins loaded)`);
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...files], {
        cwd: path.join(pluginsDirectory, name),
        env: { ...process.env, TSPP_TEST_ALL_PLUGINS: "1" },
        stdio: "inherit",
    });
    if (result.status !== 0) failed.push(name);
}
if (failed.length) {
    console.error(`\nFailed with all plugins loaded: ${failed.join(", ")}`);
    process.exit(1);
}
