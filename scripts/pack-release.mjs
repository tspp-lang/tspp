// Assembles what a release would publish into release/: one tarball per public package and the VS Code extension.
// Nothing is published. packages/compiler/lib is the bootstrap compiler the repository tracks and knows nothing of TS++,
// so the compiler's tarball is staged with a lib produced from the fresh build instead.
// Usage: node scripts/pack-release.mjs [--skip-build]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const compiler = path.join(root, "packages", "compiler");
const extension = path.join(root, "packages", "vscode-extension");

function run(command, args, cwd) {
    const windows = process.platform === "win32" && command !== process.execPath;
    const result = spawnSync(windows ? (process.env.ComSpec ?? "cmd.exe") : command, [
        ...(windows ? ["/d", "/s", "/c", command] : []),
        ...args,
    ], { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
}

function readManifest(directory) {
    return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
}

function writeManifest(directory, manifest) {
    fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
}

function childPackages(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(directory, entry.name, "package.json")))
        .map(entry => path.join(directory, entry.name));
}

function withStage(prefix, stageWork) {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
        stageWork(stage);
    }
    finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
}

const publicPackages = [...childPackages(path.join(root, "packages")), ...childPackages(path.join(root, "packages", "plugins"))]
    .filter(directory => !readManifest(directory).private);
const versions = new Map(publicPackages.map(directory => {
    const { name, version } = readManifest(directory);
    return [name, version];
}));

function workspaceVersion(name) {
    const version = versions.get(name);
    if (!version) throw new Error(`Workspace dependency ${name} is not a public package.`);
    return version;
}

function packCompiler() {
    withStage("tspp-release-compiler-", stage => {
        for (const file of ["bin", "LICENSE.txt", "README.md", "SECURITY.md", "ThirdPartyNoticeText.txt"]) {
            fs.cpSync(path.join(compiler, file), path.join(stage, file), { recursive: true });
        }
        run(process.execPath, [path.join("scripts", "produceLKG.mjs"), path.join(stage, "lib")], compiler);
        const { scripts, devDependencies, overrides, volta, ...manifest } = readManifest(compiler);
        manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).map(([name, range]) => [
            name,
            range.startsWith("workspace:") ? workspaceVersion(name) : range,
        ]));
        writeManifest(stage, manifest);
        run("npm", ["pack", "--ignore-scripts", "--pack-destination", release], stage);
    });
}

function tarballOf(name, version) {
    return path.join(release, `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`);
}

// The extension runs the language server and compiler it ships with, so it installs them from the tarballs above.
function packExtension() {
    withStage("tspp-release-vscode-", stage => {
        for (const file of ["extension.js", "language-configuration.json", "plugin-contributions.json", "README.md", "syntaxes"]) {
            fs.cpSync(path.join(extension, file), path.join(stage, file), { recursive: true });
        }
        const { scripts, devDependencies, ...manifest } = readManifest(extension);
        manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).map(([name, range]) => [
            name,
            range.startsWith("workspace:") ? `file:${tarballOf(name, workspaceVersion(name))}` : range,
        ]));
        writeManifest(stage, manifest);
        run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], stage);
        const output = path.join(release, `${manifest.name}-${manifest.version}.vsix`);
        // Fetched for this step alone: vsce brings native dependencies the workspace has no other use for.
        run("npm", ["exec", "--yes", "--ignore-scripts", "--package=@vscode/vsce@3.9.2", "--", "vsce", "package", "--skip-license", "--out", output], stage);
    });
}

if (!process.argv.includes("--skip-build")) run("pnpm", ["build:vscode:dev"], root);
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(release);
for (const directory of publicPackages) {
    if (directory === compiler) packCompiler();
    else run("pnpm", ["pack", "--pack-destination", release], directory);
}
packExtension();
console.log(`\nAssembled in ${path.relative(root, release)}:`);
for (const file of fs.readdirSync(release).sort()) console.log(`  ${file}`);
