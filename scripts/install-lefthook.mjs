import { spawnSync } from "child_process";
import { createRequire } from "module";

if (process.env.CI) {
  console.log("Skipping Git hook installation in CI.");
  process.exit(0);
}

const gitVersion = spawnSync("git", ["--version"], { encoding: "utf8" });
const match = gitVersion.stdout?.match(/git version (\d+)\.(\d+)/);

if (!match) {
  console.warn("Skipping Git hook installation because Git is unavailable.");
  process.exit(0);
}

const major = Number(match[1]);
const minor = Number(match[2]);

if (major < 2 || (major === 2 && minor < 31)) {
  console.warn(`Skipping Lefthook: Git ${major}.${minor} is older than the required 2.31.`);
  process.exit(0);
}

const require = createRequire(import.meta.url);
const lefthookBin = require.resolve("lefthook");
const lefthook = spawnSync(process.execPath, [lefthookBin, "install"], { stdio: "inherit" });

if (lefthook.error) {
  console.error(`Failed to start Lefthook: ${lefthook.error.message}`);
  process.exit(1);
}

process.exit(lefthook.status ?? 1);
