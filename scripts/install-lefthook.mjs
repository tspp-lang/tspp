import { spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const portableHook = "#!/bin/sh\n# tspp-format-staged-hook v1\nexec node scripts/format-staged.mjs\n";

export function installPortableFormatHook({ cwd = process.cwd(), env = process.env } = {}) {
  const git = args => {
    const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args[0]} failed.`);
    return result.stdout.trimEnd();
  };
  const repositoryRoot = git(["rev-parse", "--show-toplevel"]);
  const hookPath = path.resolve(repositoryRoot, git(["rev-parse", "--git-path", "hooks/pre-commit"]));
  let existing;
  try {
    existing = fs.lstatSync(hookPath);
  }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isFile() || fs.readFileSync(hookPath, "utf8") !== portableHook) {
      throw new Error(`Preserving the existing hook at ${hookPath}. Add 'node scripts/format-staged.mjs' to that hook, or move it before reinstalling.`);
    }
  }
  else {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, portableHook, { flag: "wx", mode: 0o755 });
  }
  fs.chmodSync(hookPath, 0o755);
  return hookPath;
}

export function installHooks({ cwd = process.cwd(), env = process.env, log = console } = {}) {
  if (env.CI) {
    log.log("Skipping Git hook installation in CI.");
    return 0;
  }

  const gitVersion = spawnSync("git", ["--version"], { cwd, env, encoding: "utf8" });
  const match = gitVersion.stdout?.match(/git version (\d+)\.(\d+)/);
  if (!match) {
    log.warn("Skipping Git hook installation because Git is unavailable.");
    return 0;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);

  if (major < 2 || (major === 2 && minor < 31)) {
    installPortableFormatHook({ cwd, env });
    log.log(`Installed the staged newline normalization hook for Git ${major}.${minor}. Lefthook's other checks require Git 2.31+.`);
    return 0;
  }

  const require = createRequire(import.meta.url);
  const lefthookBin = require.resolve("lefthook");
  const lefthook = spawnSync(process.execPath, [lefthookBin, "install"], { cwd, env, stdio: "inherit" });
  if (lefthook.error) {
    log.error(`Failed to start Lefthook: ${lefthook.error.message}`);
    return 1;
  }
  return lefthook.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = installHooks();
  }
  catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
