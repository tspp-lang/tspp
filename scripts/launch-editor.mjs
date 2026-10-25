import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const rootDir = process.cwd();
const extensionDir = path.resolve(rootDir, "packages/vscode-extension");
const examplesDir = path.resolve(rootDir, "packages/examples");

console.log("\x1b[36m%s\x1b[0m", "============================================================");
console.log("\x1b[1m\x1b[32m%s\x1b[0m", "🚀 [TS++] 准备启动 TS++ 扩展开发宿主环境...");
console.log("\x1b[36m%s\x1b[0m", "============================================================");

// 1. 先构建编译器与语言服务器
console.log("\x1b[33m%s\x1b[0m", "📦 [1/2] 正在构建编译器与语言服务器 (pnpm build:editor)...");
const pnpmCmd = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS;
delete cleanEnv.VSCODE_INSPECTOR_OPTIONS;

const buildResult = spawnSync(pnpmCmd, ["build:editor"], {
  cwd: rootDir,
  stdio: "inherit",
  shell: true,
  env: cleanEnv,
});

if (buildResult.status !== 0) {
  console.error("\x1b[31m%s\x1b[0m", "\n❌ [TS++] 构建失败，退出码: " + buildResult.status);
  console.error("\x1b[31m%s\x1b[0m", "请根据上方报错排查问题后重试。");
  process.exit(buildResult.status ?? 1);
}

// 2. 启动 VS Code 实例
console.log("\x1b[32m%s\x1b[0m", "\n✨ [2/2] 构建成功！正在拉起 VS Code 扩展宿主窗口...");
console.log("\x1b[90m%s\x1b[0m", `📁 扩展路径: ${extensionDir}`);
console.log("\x1b[90m%s\x1b[0m", `📁 示例路径: ${examplesDir}`);
console.log("\x1b[36m%s\x1b[0m", "------------------------------------------------------------");
console.log("\x1b[1m\x1b[32m%s\x1b[0m", "🟢 VS Code 实例正在运行中...");
console.log("\x1b[33m%s\x1b[0m", "💡 只要扩展窗口未关闭，当前终端就会一直保持运行。");
console.log("\x1b[33m%s\x1b[0m", "💡 关闭新开的 VS Code 窗口，或在当前终端按 Ctrl+C 即可退出。");
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
  examplesDir,
];

const codeProcess = spawn(codeCmd, codeArgs, {
  cwd: rootDir,
  stdio: "inherit",
  shell: true,
  env: cleanEnv,
});

codeProcess.on("error", (err) => {
  console.error("\x1b[31m%s\x1b[0m", "\n❌ 无法启动 'code' 命令。请确保 VS Code 已安装并加入了系统环境变量 PATH。");
  console.error(err);
  process.exit(1);
});

codeProcess.on("exit", (code, signal) => {
  console.log("\x1b[36m%s\x1b[0m", "\n============================================================");
  if (code === 0) {
    console.log("\x1b[32m%s\x1b[0m", "👋 VS Code 扩展宿主窗口已关闭，启动脚本正常退出。");
  } else {
    console.log("\x1b[33m%s\x1b[0m", `ℹ️ VS Code 进程已退出 (code: ${code}, signal: ${signal})。`);
  }
  console.log("\x1b[36m%s\x1b[0m", "============================================================");
  process.exit(code ?? 0);
});

// 处理终端 Ctrl+C 退出
process.on("SIGINT", () => {
  console.log("\x1b[33m%s\x1b[0m", "\n🛑 收到中断信号 (Ctrl+C)，正在退出终端...");
  codeProcess.kill();
  process.exit(0);
});
