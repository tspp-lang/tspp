import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const script = process.argv[2] ?? "check";
const packageManagerExecPath = process.env.npm_execpath;
if (!packageManagerExecPath) throw new Error("npm_execpath is unavailable; run this script through pnpm");

const projects = readdirSync(root, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^\d{2}-/.test(entry.name))
  .map(entry => entry.name)
  .sort();

for (const project of projects) {
  console.log(`\n> ${project}: ${script}`);
  const result = spawnSync(packageManagerExecPath, ["run", "--if-present", script], {
    cwd: join(root, project),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
