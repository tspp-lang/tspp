// Assembles what a release would publish into release/: the ts-plus-plus package and the VS Code extension, both at the
// version of the repository's root package.json. Nothing is published. Every other package of the workspace is internal
// and versioned 0.0.0: the plugins and the SDK travel inside ts-plus-plus as bundled dependencies, and the extension
// carries the language server and the SDK it runs. packages/compiler/lib is the bootstrap compiler the repository tracks
// and knows nothing of TS++, so ts-plus-plus is staged with a lib produced from the fresh build instead. Its own version
// stays the TypeScript version it implements, which the release records as `typescriptVersion` for editors to read.
// Usage: node scripts/pack-release.mjs [--skip-build]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { shippedPluginPackages } from "./plugin-entries.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const compiler = path.join(root, "packages", "compiler");
const extension = path.join(root, "packages", "vscode-extension");

function run(command, args, cwd, options = {}) {
    const windows = process.platform === "win32" && command !== process.execPath;
    const result = spawnSync(windows ? (process.env.ComSpec ?? "cmd.exe") : command, [
        ...(windows ? ["/d", "/s", "/c", command] : []),
        ...args,
    ], { cwd, stdio: "inherit", ...options });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}.`);
    return result.stdout;
}

function git(...args) {
    return run("git", args, root, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" }).trim();
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
        return stageWork(stage);
    }
    finally {
        fs.rmSync(stage, { recursive: true, force: true });
    }
}

const version = readManifest(root).version;
if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version ?? "")) throw new Error(`The root package.json has no release version (${version}).`);

const workspacePackages = new Map([...childPackages(path.join(root, "packages")), ...childPackages(path.join(root, "packages", "plugins"))]
    .map(directory => [readManifest(directory).name, directory]));

function workspaceDependencies(manifest) {
    return Object.entries(manifest.dependencies ?? {}).filter(([, range]) => range.startsWith("workspace:")).map(([name]) => name);
}

/** The internal packages a package needs at run time, directly or through one another. */
function internalClosure(names) {
    const closure = new Set();
    const visit = name => {
        if (closure.has(name)) return;
        const directory = workspacePackages.get(name);
        if (!directory) throw new Error(`Workspace dependency ${name} is not a package of this repository.`);
        closure.add(name);
        workspaceDependencies(readManifest(directory)).forEach(visit);
    };
    names.forEach(visit);
    return [...closure].sort();
}

/** Packs each internal package as pnpm would publish it, with workspace ranges replaced, and returns the tarballs. */
function packInternal(names, destination) {
    return new Map(names.map(name => {
        const output = path.join(destination, name.replace(/^@/, "").replace("/", "-"));
        fs.mkdirSync(output, { recursive: true });
        run("pnpm", ["pack", "--pack-destination", output], workspacePackages.get(name));
        const [tarball] = fs.readdirSync(output);
        return [name, path.join(output, tarball)];
    }));
}

function extract(tarball, directory) {
    fs.mkdirSync(directory, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", directory, "--strip-components=1"], root);
}

// The bundled packages are installed with ts-plus-plus, so what they depend on from the registry becomes its dependency.
function hoistedDependencies(bundled, stage) {
    const hoisted = {};
    for (const name of bundled) {
        for (const [dependency, range] of Object.entries(readManifest(path.join(stage, "node_modules", name)).dependencies ?? {})) {
            if (bundled.includes(dependency)) continue;
            if (hoisted[dependency] && hoisted[dependency] !== range) {
                throw new Error(`${dependency} is required as both ${hoisted[dependency]} and ${range} by bundled packages.`);
            }
            hoisted[dependency] = range;
        }
    }
    return hoisted;
}

function packCompiler(tarballs, gitHead) {
    return withStage("tspp-release-compiler-", stage => {
        for (const file of ["bin", "plugins", "LICENSE.txt", "README.md", "SECURITY.md", "ThirdPartyNoticeText.txt"]) {
            fs.cpSync(path.join(compiler, file), path.join(stage, file), { recursive: true });
        }
        run(process.execPath, [path.join("scripts", "produceLKG.mjs"), path.join(stage, "lib")], compiler);
        const bundled = [...tarballs.keys()];
        for (const [name, tarball] of tarballs) extract(tarball, path.join(stage, "node_modules", name));
        const { scripts, devDependencies, overrides, volta, version: typescriptVersion, dependencies, ...rest } = readManifest(compiler);
        const manifest = { name: rest.name, version, typescriptVersion, ...rest };
        manifest.dependencies = {
            ...Object.fromEntries(bundled.map(name => [name, readManifest(path.join(stage, "node_modules", name)).version])),
            ...hoistedDependencies(bundled, stage),
            ...Object.fromEntries(Object.entries(dependencies).filter(([name]) => !bundled.includes(name))),
        };
        manifest.bundleDependencies = bundled;
        manifest.gitHead = gitHead;
        writeManifest(stage, manifest);
        run("npm", ["pack", "--ignore-scripts", "--pack-destination", release], stage);
        return path.join(release, `${manifest.name}-${version}.tgz`);
    });
}

// The extension runs the language server and compiler it ships with. Plugins it reaches through ts-plus-plus, by the
// names projects give them, so only what extension.js loads itself is installed beside it.
function packExtension(compilerTarball, internalTarballs) {
    const plugins = new Set(shippedPluginPackages());
    withStage("tspp-release-vscode-", stage => {
        for (const file of ["extension.js", "language-configuration.json", "plugin-contributions.json", "README.md", "syntaxes"]) {
            fs.cpSync(path.join(extension, file), path.join(stage, file), { recursive: true });
        }
        const { scripts, devDependencies, ...manifest } = readManifest(extension);
        manifest.version = version;
        manifest.dependencies = Object.fromEntries(Object.entries(manifest.dependencies).flatMap(([name, range]) => {
            if (!range.startsWith("workspace:")) return [[name, range]];
            if (plugins.has(name)) return [];
            return [[name, `file:${name === "ts-plus-plus" ? compilerTarball : internalTarballs.get(name)}`]];
        }));
        writeManifest(stage, manifest);
        run("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], stage);
        const output = path.join(release, `${manifest.name}-${version}.vsix`);
        // Fetched for this step alone: vsce brings native dependencies the workspace has no other use for.
        run("npm", ["exec", "--yes", "--ignore-scripts", "--package=@vscode/vsce@3.9.2", "--", "vsce", "package", "--skip-license", "--out", output], stage);
    });
}

const gitHead = git("rev-parse", "HEAD");
if (!process.argv.includes("--skip-build")) run("pnpm", ["build:vscode:dev"], root);
fs.rmSync(release, { recursive: true, force: true });
fs.mkdirSync(release);
withStage("tspp-release-internal-", internal => {
    const compilerTarball = packCompiler(packInternal(internalClosure(workspaceDependencies(readManifest(compiler))), internal), gitHead);
    const extensionInternal = workspaceDependencies(readManifest(extension)).filter(name => name !== "ts-plus-plus" && !shippedPluginPackages().includes(name));
    packExtension(compilerTarball, packInternal(internalClosure(extensionInternal), internal));
});
console.log(`\nAssembled ${version} from ${gitHead} in ${path.relative(root, release)}:`);
for (const file of fs.readdirSync(release).sort()) console.log(`  ${file}`);
const tag = `v${version}`;
if (git("status", "--porcelain")) console.log(`\nThe working tree has uncommitted changes, so these files match no commit.`);
else if (!git("tag", "--points-at", "HEAD").split(/\r?\n/).includes(tag)) console.log(`\n${gitHead} is not tagged ${tag}; the release workflow tags the commit it publishes.`);
