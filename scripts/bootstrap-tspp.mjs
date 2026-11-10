import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { commit } = JSON.parse(readFileSync(join(root, "scripts", "bootstrap-pin.json"), "utf8"));
const cache = resolve(process.env.TSPP_BOOTSTRAP_CACHE ?? join(root, ".bootstrap"));
const sourceRoot = process.env.TSPP_BOOTSTRAP_SOURCE ?? root;
const require = createRequire(import.meta.url);
const mode = process.env.TSPP_BOOTSTRAP ?? "pinned";

function run(command, args, options = {}) {
    const pnpmOnWindows = command === "pnpm" && process.platform === "win32";
    const result = spawnSync(pnpmOnWindows ? process.env.ComSpec ?? "cmd.exe" : command,
        pnpmOnWindows ? ["/d", "/s", "/c", command, ...args] : args,
        { cwd: root, stdio: "inherit", ...options });
    if (result.error) throw result.error;
    return result.status ?? 1;
}

function check(command, args, options) {
    const status = run(command, args, options);
    if (status) throw new Error(command + " " + args.join(" ") + " exited with code " + status);
}

function verifyPackage(directory) {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (manifest.name !== "ts-plus-plus" || manifest.gitHead !== commit || !existsSync(join(directory, "bin", "tspp"))) {
        throw new Error("Invalid TS++ bootstrap package for " + commit + " in " + directory);
    }
}

function installPinned() {
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("The TS++ bootstrap pin must be a full commit SHA.");
    const installation = join(cache, commit);
    const directory = join(installation, "package");
    if (existsSync(installation)) {
        verifyPackage(directory);
        return directory;
    }

    console.log("Building the TS++ bootstrap package from " + commit);
    if (run("git", ["cat-file", "-e", commit + "^{commit}"], { cwd: sourceRoot, stdio: "ignore" })) {
        check("git", ["fetch", "--no-tags", "--depth=1", "origin", commit], { cwd: sourceRoot });
    }

    mkdirSync(cache, { recursive: true });
    const staging = mkdtempSync(join(cache, ".install-"));
    try {
        const checkout = join(staging, "src");
        check("git", ["init", "--quiet", checkout]);
        const git = args => check("git", ["-C", checkout, "-c", "core.longpaths=true", ...args]);
        // In a shallow CI checkout the seed may only be in FETCH_HEAD, with no advertised ref.
        git(["fetch", "--quiet", "--no-tags", "--depth=1",
            "--upload-pack=git -c uploadpack.allowAnySHA1InWant=true upload-pack", sourceRoot, commit]);
        git(["checkout", "--quiet", "--detach", commit]);

        // A newer seed may need its own older pin. Reuse the outer Git checkout and package cache.
        const env = { ...process.env, CI: "true", TSPP_BOOTSTRAP: "pinned", TSPP_BOOTSTRAP_CACHE: cache, TSPP_BOOTSTRAP_SOURCE: sourceRoot };
        check("pnpm", ["install", "--frozen-lockfile"], { cwd: checkout, env });
        check(process.execPath, ["scripts/pack-release.mjs", "--compiler-only"], { cwd: checkout, env });

        const version = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version;
        const archiveName = "ts-plus-plus-" + version + ".tgz";
        const archive = join(checkout, ".bootstrap", "compiler-package", archiveName);
        const output = join(staging, "output");
        mkdirSync(output);
        check("tar", ["-xzf", archive, "-C", output]);
        verifyPackage(join(output, "package"));
        renameSync(archive, join(output, archiveName));
        try {
            renameSync(output, installation);
        }
        catch (error) {
            if (!existsSync(installation)) throw error;
            verifyPackage(directory);
        }
        return directory;
    }
    finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

function compilePinned(directory, args) {
    const compiler = join(directory, "bin", "tspp");
    const projectIndex = args.findIndex(arg => arg === "-p" || arg === "--project");
    if (projectIndex < 0) return run(process.execPath, [compiler, ...args], { cwd: process.cwd() });

    const target = resolve(args[projectIndex + 1]);
    const project = statSync(target).isDirectory() ? join(target, "tsconfig.json") : target;
    const ts = require(join(directory, "lib", "typescript.js"));
    const fail = diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")); };
    const parsed = ts.getParsedCommandLineOfConfigFile(project, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: fail });
    if (parsed.errors.length) fail(parsed.errors[0]);
    const plugins = parsed.options.plugins?.map(plugin => {
        if (!plugin.tspp) return plugin;
        const entry = /^ts-plus-plus\/plugins\/([a-z0-9-]+(?:\/[a-z0-9-]+)*)$/.exec(plugin.name)?.[1];
        if (!entry) throw new Error("A pinned build needs a bundled TS++ plugin, got " + plugin.name);
        return { ...plugin, name: join(directory, "plugins", entry + ".js").replaceAll("\\", "/") };
    });

    const staging = mkdtempSync(join(cache, ".project-"));
    try {
        const config = join(staging, "tsconfig.json");
        // Keep the project's paths relative to the original config, while resolving TS++ plugins from the seed.
        writeFileSync(config, JSON.stringify({
            extends: project,
            compilerOptions: { plugins },
            references: parsed.projectReferences?.map(reference => ({ path: reference.path })),
        }));
        args[projectIndex + 1] = config;
        return run(process.execPath, [compiler, ...args], { cwd: process.cwd() });
    }
    finally {
        rmSync(staging, { recursive: true, force: true });
    }
}

try {
    const args = process.argv.slice(2);
    if (mode === "dev") {
        const compiler = join(root, "packages", "compiler", "built", "local", "tsc.js");
        if (!existsSync(compiler)) throw new Error("Build the workspace compiler first with pnpm build:compiler.");
        if (args.length) process.exitCode = run(process.execPath, [compiler, ...args], { cwd: process.cwd() });
    }
    else if (mode === "pinned") {
        const directory = installPinned();
        if (args.length) process.exitCode = compilePinned(directory, args);
    }
    else throw new Error("TSPP_BOOTSTRAP must be pinned or dev.");
}
catch (error) {
    console.error("TS++ bootstrap: " + error.message);
    process.exitCode = 1;
}
