import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = path.resolve(rootDir, "packages/vscode-extension");

console.log("\x1b[36m%s\x1b[0m", "============================================================");
console.log("\x1b[1m\x1b[32m%s\x1b[0m", "[TS++] Preparing the extension development host...");
console.log("\x1b[36m%s\x1b[0m", "============================================================");

const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS;
delete cleanEnv.VSCODE_INSPECTOR_OPTIONS;

console.log("\x1b[33m%s\x1b[0m", "[1/2] Building the SDK, plugins, compiler, language server, and extension...");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const buildResult = spawnSync(pnpmCmd, ["build:vscode:dev"], {
  cwd: rootDir,
  stdio: "inherit",
  shell: true,
  env: cleanEnv,
});

if (buildResult.status !== 0) {
  console.error("\x1b[31m%s\x1b[0m", `Build failed with exit code ${buildResult.status}.`);
  process.exit(buildResult.status ?? 1);
}

console.log("\x1b[32m%s\x1b[0m", "[2/2] Build complete. Launching the Extension Development Host...");
console.log("\x1b[90m%s\x1b[0m", `Extension: ${extensionDir}`);
console.log("\x1b[90m%s\x1b[0m", `Workspace: ${rootDir}`);
console.log("\x1b[33m%s\x1b[0m", "This terminal will remain active until the development host is closed.");
console.log("\x1b[36m%s\x1b[0m", "============================================================");

const codeCmd = process.platform === "win32" ? "code.cmd" : "code";
const codeArgs = [
  "--new-window",
  "--wait",
  `--extensionDevelopmentPath=${extensionDir}`,
  "--disable-extension=shalldie.background",
  "--disable-extension=rbuckton.tsserver-live-reload",
  "--disable-extension=wakatime.vscode-wakatime",
  "--disable-extension=fittentech.fitten-code",
  "--disable-extension=biomejs.biome",
  rootDir,
];

const codeProcess = spawn(codeCmd, codeArgs, {
  cwd: rootDir,
  stdio: "inherit",
  shell: true,
  env: cleanEnv,
});

codeProcess.on("error", error => {
  console.error("\x1b[31m%s\x1b[0m", "Unable to start the 'code' command. Ensure VS Code is available on PATH.");
  console.error(error);
  process.exit(1);
});

codeProcess.on("exit", (code, signal) => {
  console.log("\x1b[36m%s\x1b[0m", "============================================================");
  if (code === 0) {
    console.log("\x1b[32m%s\x1b[0m", "The Extension Development Host was closed.");
  } else {
    console.log("\x1b[33m%s\x1b[0m", `VS Code exited (code: ${code}, signal: ${signal}).`);
  }
  console.log("\x1b[36m%s\x1b[0m", "============================================================");
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  console.log("\x1b[33m%s\x1b[0m", "Stopping the extension development host launcher...");
  codeProcess.kill();
  process.exit(0);
});
