import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import process from "node:process";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const extensionDir = path.resolve(rootDir, "packages/vscode-extension");
const workspaceDir = path.resolve(rootDir, "packages/examples");

function commandInvocation(command, args) {
  if (process.platform !== "win32") return { command, args };
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args],
  };
}

console.log(
  "\x1b[36m%s\x1b[0m",
  "============================================================",
);
console.log(
  "\x1b[1m\x1b[32m%s\x1b[0m",
  "[TS++] Preparing the extension development host...",
);
console.log(
  "\x1b[36m%s\x1b[0m",
  "============================================================",
);

const cleanEnv = { ...process.env };
delete cleanEnv.NODE_OPTIONS;
delete cleanEnv.VSCODE_INSPECTOR_OPTIONS;

console.log(
  "\x1b[33m%s\x1b[0m",
  "[1/2] Building the SDK, plugins, compiler, language server, and extension...",
);
const buildCommand = commandInvocation("pnpm", ["build:vscode:dev"]);
const buildResult = spawnSync(buildCommand.command, buildCommand.args, {
  cwd: rootDir,
  stdio: "inherit",
  env: cleanEnv,
});

if (buildResult.status !== 0) {
  console.error(
    "\x1b[31m%s\x1b[0m",
    `Build failed with exit code ${buildResult.status}.`,
  );
  process.exit(buildResult.status ?? 1);
}

function detectEditor() {
  if (process.env.TSPP_EDITOR) {
    return {
      command: process.env.TSPP_EDITOR,
      source: "TSPP_EDITOR",
    };
  }

  // Check if running inside Google Antigravity agent environment
  if (
    process.env.ANTIGRAVITY_AGENT ||
    process.env.ANTIGRAVITY_AUTH_SUCCESS_APP ||
    process.env.ANTIGRAVITY_APP_DATA_DIR ||
    process.env.ANTIGRAVITY_VSCODE_HOST
  ) {
    return {
      command: "antigravity",
      source: "ANTIGRAVITY_* env",
    };
  }

  let requireCacheKeys;
  try {
    const req = createRequire(import.meta.url);
    requireCacheKeys = Object.keys(req.cache ?? {}).join(";");
  } catch {
    requireCacheKeys = undefined;
  }

  // Gather candidate paths/configs from F5 debugger (launch.json / js-debug),
  // Integrated Terminal (Git askpass / browser helpers), and Extension Host.
  const hintEntries = [
    ["VSCODE_EXEC_PATH", process.env.VSCODE_EXEC_PATH],
    ["VSCODE_GIT_ASKPASS_NODE", process.env.VSCODE_GIT_ASKPASS_NODE],
    ["VSCODE_GIT_ASKPASS_MAIN", process.env.VSCODE_GIT_ASKPASS_MAIN],
    ["BROWSER", process.env.BROWSER],
    ["NODE_OPTIONS", process.env.NODE_OPTIONS],
    ["VSCODE_INSPECTOR_OPTIONS", process.env.VSCODE_INSPECTOR_OPTIONS],
    ["VSCODE_NLS_CONFIG", process.env.VSCODE_NLS_CONFIG],
    ["VSCODE_CODE_CACHE_PATH", process.env.VSCODE_CODE_CACHE_PATH],
    [
      "process._preload_modules",
      Array.isArray(process._preload_modules)
        ? process._preload_modules.join(";")
        : undefined,
    ],
    ["require.cache", requireCacheKeys],
  ].filter(([, value]) => Boolean(value));

  for (const [key, value] of hintEntries) {
    if (/Antigravity/i.test(value)) {
      return {
        command: "antigravity",
        source: `${key} (${value})`,
      };
    }
  }

  // Cursor
  if (process.env.CURSOR_AGENT) {
    return {
      command: "cursor",
      source: "CURSOR_AGENT",
    };
  }
  for (const [key, value] of hintEntries) {
    if (/Cursor/i.test(value)) {
      return {
        command: "cursor",
        source: `${key} (${value})`,
      };
    }
  }

  // VSCodium
  for (const [key, value] of hintEntries) {
    if (/VSCodium/i.test(value)) {
      return {
        command: "codium",
        source: `${key} (${value})`,
      };
    }
  }

  return {
    command: "code",
    source:
      hintEntries.length > 0
        ? `fallback (checked: ${hintEntries.map(([k]) => k).join(", ")})`
        : "fallback (no IDE env hints found)",
  };
}

const detectedEditor = detectEditor();
const editorCommand = detectedEditor.command;

console.log(
  "\x1b[32m%s\x1b[0m",
  `[2/2] Build complete. Launching the Extension Development Host with '${editorCommand}'...`,
);
console.log(
  "\x1b[90m%s\x1b[0m",
  `Detected editor via: ${detectedEditor.source}`,
);
console.log("\x1b[90m%s\x1b[0m", `Extension: ${extensionDir}`);
console.log("\x1b[90m%s\x1b[0m", `Workspace: ${workspaceDir}`);
console.log(
  "\x1b[33m%s\x1b[0m",
  "This terminal will remain active until the development host is closed.",
);
console.log(
  "\x1b[36m%s\x1b[0m",
  "============================================================",
);

const codeArgs = [
  "--new-window",
  "--wait",
  `--extensionDevelopmentPath=${extensionDir}`,
  "--disable-extension=shalldie.background",
  "--disable-extension=rbuckton.tsserver-live-reload",
  "--disable-extension=wakatime.vscode-wakatime",
  "--disable-extension=fittentech.fitten-code",
  "--disable-extension=biomejs.biome",
  workspaceDir,
];
const codeCommand = commandInvocation(editorCommand, codeArgs);

const codeProcess = spawn(codeCommand.command, codeCommand.args, {
  cwd: rootDir,
  stdio: "inherit",
  env: cleanEnv,
});

codeProcess.on("error", (error) => {
  console.error(
    "\x1b[31m%s\x1b[0m",
    `Unable to start the '${editorCommand}' command. Ensure it is available on PATH.`,
  );
  console.error(error);
  process.exit(1);
});

codeProcess.on("exit", (code, signal) => {
  console.log(
    "\x1b[36m%s\x1b[0m",
    "============================================================",
  );
  if (code === 0) {
    console.log(
      "\x1b[32m%s\x1b[0m",
      "The Extension Development Host was closed.",
    );
  } else {
    console.log(
      "\x1b[33m%s\x1b[0m",
      `VS Code exited (code: ${code}, signal: ${signal}).`,
    );
  }
  console.log(
    "\x1b[36m%s\x1b[0m",
    "============================================================",
  );
  process.exit(code ?? 0);
});

process.on("SIGINT", () => {
  console.log(
    "\x1b[33m%s\x1b[0m",
    "Stopping the extension development host launcher...",
  );
  codeProcess.kill();
  process.exit(0);
});
