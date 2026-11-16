import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
function task(...args) {
  return spawnSync(process.execPath, ["scripts/bootstrap-tasks.mjs", ...args], {
    cwd: root, encoding: "utf8", timeout: 120000,
  });
}

test("repository task plan lists the build dependencies", () => {
  const result = task("build", "--dry-run");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /build:plugin-sdk/);
  assert.match(result.stdout, /build:compiler/);
});

test("root aliases forward arguments to the selected command", () => {
  const result = task("--alias", "check:skills", "--invalid-option");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage: node scripts\/build-skills\.mjs/);
});

test("clean dispatches to filtered package scripts without invoking the workspace root", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-task-clean-"));
  assert.ok(directory.startsWith(path.join(os.tmpdir(), "tspp-task-clean-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, content) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("package.json", JSON.stringify({
    name: "task-clean-dispatch-workspace", private: true, packageManager: "pnpm@12.4.2",
    scripts: { clean: "node -e \"throw new Error('Root clean must not run as a package leaf')\"" },
  }));
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n  - packages/plugins/*\n");
  const packages = [
    ["packages/sdk", "@tspp/plugin-sdk"],
    ["packages/plugins/demo", "@tspp/plugin-fixture"],
    ["packages/compiler", "ts-plus-plus"],
    ["packages/language-server", "tspp-language-server"],
  ];
  for (const [location, name] of packages) {
    write(`${location}/package.json`, JSON.stringify({ name, version: "0.0.0", scripts: {
      clean: "node -e \"require('node:fs').appendFileSync(process.env.TASK_KIT_CLEAN_LOG, process.cwd()+'\\n')\"",
    } }));
  }
  const log = path.join(directory, "cleaned.txt");
  const result = spawnSync(process.execPath, [path.join(root, "scripts/task/tasks.ts"), "clean"], {
    cwd: directory, encoding: "utf8", timeout: 60000,
    env: { ...process.env, CI: "true", TASK_KIT_CLEAN_LOG: log },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n")
    .map(file => path.relative(directory, file).split(path.sep).join("/")), packages.map(([location]) => location));
});

test("language-server clean removes build outputs while preserving unrelated files", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-lsp-clean-"));
  assert.ok(directory.startsWith(path.join(os.tmpdir(), "tspp-lsp-clean-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, "lib"));
  fs.writeFileSync(path.join(directory, "lib/index.js"), "output");
  fs.writeFileSync(path.join(directory, "project.tsbuildinfo"), "build state");
  fs.writeFileSync(path.join(directory, "keep.txt"), "source");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "packages/language-server/package.json"), "utf8"));
  const result = spawnSync(manifest.scripts.clean, {
    cwd: directory, encoding: "utf8", shell: true, timeout: 15000,
    env: { ...process.env, PATH: path.join(root, "node_modules/.bin") + path.delimiter + process.env.PATH },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(directory, "lib")), false);
  assert.equal(fs.existsSync(path.join(directory, "project.tsbuildinfo")), false);
  assert.equal(fs.readFileSync(path.join(directory, "keep.txt"), "utf8"), "source");
});

test("a failed prerequisite rebuild retries its consumers even when old outputs remain", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-task-bootstrap-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const write = (name, content) => {
    const file = path.join(directory, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write("scripts/bootstrap-tasks.mjs", fs.readFileSync(path.join(root, "scripts/bootstrap-tasks.mjs")));
  write("packages/plugin-sdk/src/index.ts", "original");
  write("packages/plugins/demo/package.json", JSON.stringify({ scripts: { build: "fake" } }));
  write("packages/compiler/src/index.ts", "original");
  write("pnpm.cjs", `
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), filter = args[args.indexOf('--filter') + 1];
const stage = filter === '@tspp/plugin-sdk' ? 'sdk' : filter === './packages/plugins/**' ? 'plugins' : filter === 'ts-plus-plus' ? 'compiler' : filter === '@tspp/command-kit' ? 'command-kit' : 'task-kit';
fs.appendFileSync('builds.log', stage + '\\n');
if (process.env.FAIL_STAGE === stage) process.exit(2);
const outputs = {
  sdk: ['packages/plugin-sdk/dist/index.js'],
  plugins: ['packages/plugins/demo/dist/index.js'],
  compiler: ['packages/compiler/built/local/tsc.js', 'packages/compiler/built/local/typescript.js'],
  'command-kit': ['packages/example-projects/command-kit/dist/index.js'],
  'task-kit': ['packages/example-projects/task-kit/dist/index.js'],
};
for (const file of outputs[stage]) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, 'output'); }
`);
  const bootstrap = failStage => spawnSync(process.execPath, ["scripts/bootstrap-tasks.mjs", "--bootstrap-only"], {
    cwd: directory, encoding: "utf8", timeout: 30000,
    env: { ...process.env, npm_execpath: path.join(directory, "pnpm.cjs"), FAIL_STAGE: failStage ?? "" },
  });
  const first = bootstrap();
  assert.equal(first.status, 0, first.stderr);
  write("builds.log", "");
  write("packages/plugin-sdk/src/index.ts", "changed");
  const failed = bootstrap("compiler");
  assert.equal(failed.status, 2, failed.stderr);
  assert.deepEqual(fs.readFileSync(path.join(directory, "builds.log"), "utf8").trim().split("\n"), ["sdk", "plugins", "compiler"]);
  write("builds.log", "");
  const retried = bootstrap();
  assert.equal(retried.status, 0, retried.stderr);
  assert.deepEqual(fs.readFileSync(path.join(directory, "builds.log"), "utf8").trim().split("\n"), ["compiler", "command-kit", "task-kit"]);
});
