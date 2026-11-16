import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const stateFile = join(root, "node_modules/.cache/tspp-task-bootstrap.json");
const ignored = new Set(["node_modules", "dist", "built", ".git", "coverage"]);
let state = {};
try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch (error) {
  if (error.code !== "ENOENT") throw error;
}

function fingerprint(paths) {
  const hash = createHash("sha256");
  function visit(path) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat) { hash.update(`missing:${path}\n`); return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) if (!ignored.has(name)) visit(join(path, name));
    } else if (stat.isFile()) {
      hash.update(`${path}\0`);
      hash.update(readFileSync(path));
      hash.update("\0");
    }
  }
  for (const path of paths) visit(join(root, path));
  return hash.digest("hex");
}

async function run(program, args, options = {}) {
  const child = spawn(program, args, { cwd: root, stdio: "inherit", ...options });
  const forward = signal => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
  // Windows sends console Ctrl+C to the process group; child.kill would terminate it immediately.
  const onInterrupt = () => { if (process.platform !== "win32") forward("SIGINT"); };
  const onTerminate = () => forward("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (result.code !== 0) process.exit(result.code ?? (result.signal === "SIGINT" ? 130 : 143));
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

async function pnpm(args) {
  const pnpmScript = /(?:^|[\\/])pnpm\.[cm]?js$/i.test(process.env.npm_execpath ?? "") ? process.env.npm_execpath : undefined;
  if (pnpmScript) await run(process.execPath, [pnpmScript, ...args]);
  else if (process.platform === "win32") await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm.cmd", ...args]);
  else await run("pnpm", args);
}

const plugins = readdirSync(join(root, "packages/plugins"), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(root, "packages/plugins", entry.name, "package.json")) && JSON.parse(readFileSync(join(root, "packages/plugins", entry.name, "package.json"), "utf8")).scripts?.build)
  .map(entry => `packages/plugins/${entry.name}/dist/index.js`);
const stages = [
  ["sdk", ["packages/plugin-sdk", "pnpm-lock.yaml"], ["packages/plugin-sdk/dist/index.js"], ["--filter", "@tspp/plugin-sdk", "build"]],
  ["plugins", ["packages/plugins", "pnpm-lock.yaml"], plugins, ["--workspace-concurrency=1", "--filter", "./packages/plugins/**", "build"]],
  ["compiler", ["packages/compiler/src", "packages/compiler/scripts", "packages/compiler/Herebyfile.mjs", "packages/compiler/package.json", "pnpm-lock.yaml"], ["packages/compiler/built/local/tsc.js", "packages/compiler/built/local/typescript.js"], ["--filter", "ts-plus-plus", "build:compiler"]],
  ["command-kit", ["packages/example-projects/command-kit", "pnpm-lock.yaml"], ["packages/example-projects/command-kit/dist/index.js"], ["--filter", "@tspp/command-kit", "build"]],
  ["task-kit", ["packages/example-projects/task-kit", "pnpm-lock.yaml"], ["packages/example-projects/task-kit/dist/index.js"], ["--filter", "@tspp/task-kit", "build"]],
];
let changed = false;
function saveState() {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(state));
}
for (const [index, [name, inputs, outputs, args]] of stages.entries()) {
  const current = fingerprint(inputs);
  if (changed || state[name] !== current || outputs.some(path => !existsSync(join(root, path)))) {
    // A failed rebuild must remain dirty on the next invocation, including all
    // consumers of a changed prerequisite whose own source did not change.
    for (const [downstream] of stages.slice(index)) delete state[downstream];
    saveState();
    await pnpm(args);
    state[name] = fingerprint(inputs);
    changed = true;
    saveState();
  }
}
if (process.argv[2] !== "--bootstrap-only") {
  const args = process.argv.slice(2);
  const taskArgs = args[0] === "--alias"
    ? [args[1], ...(args.length > 2 ? ["--", ...args.slice(2)] : [])]
    : args;
  await run(process.execPath, ["scripts/task/tasks.ts", ...taskArgs]);
}
