import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const textExtensions = new Set([
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".tspp", ".json", ".jsonc",
    ".yaml", ".yml", ".md", ".mdx", ".txt", ".html", ".htm", ".css", ".scss", ".less", ".svg",
    ".toml", ".ini", ".cfg", ".conf", ".sh", ".ps1", ".bat", ".cmd", ".xml", ".graphql", ".gql",
]);
const textNames = new Set([".editorconfig", ".gitattributes", ".gitignore", ".npmrc", ".nvmrc", "Dockerfile"]);
const compilerScript = /^packages\/compiler\/.*\.(?:[cm]?[jt]s|[jt]sx)$/i;

export function isEligibleTextPath(fileName) {
    const segments = fileName.split("/");
    const name = segments.at(-1);
    if (segments.some(segment => [".git", "node_modules", "dist", "built", "coverage", "generated", "_namespaces", "baselines", "fixtures", "__snapshots__"].includes(segment))) return false;
    if (/^packages\/compiler\/(?:tests|lib|internal)\//.test(fileName)) return false;
    if (/\.generated\.|(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock)$/.test(fileName)) return false;
    return textNames.has(name) || textExtensions.has(path.posix.extname(fileName).toLowerCase());
}

/** This hook normalizes line endings and the final newline; it does not change code style. */
export function normalizedText(fileName, content) {
    if (!isEligibleTextPath(fileName)) return undefined;
    if (content.includes(0)) return undefined;
    const text = content.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(content)) return undefined;
    let normalized = text.replace(/\r\n?/g, "\n");
    if (normalized && !normalized.endsWith("\n")) normalized += "\n";
    if (compilerScript.test(fileName)) normalized = normalized.replace(/\n/g, "\r\n");
    return Buffer.from(normalized, "utf8");
}

function git(cwd, args, { input, env } = {}) {
    const result = spawnSync("git", args, { cwd, input, env: env ?? process.env, maxBuffer: 64 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString("utf8").trim()}`);
    return result.stdout;
}

function indexEntries(data) {
    const entries = [];
    let start = 0;
    while (start < data.length) {
        const end = data.indexOf(0, start);
        const record = data.subarray(start, end);
        const separator = record.indexOf(9);
        const [mode, hash, stage] = record.subarray(0, separator).toString("ascii").split(" ");
        const name = record.subarray(separator + 1);
        const fileName = name.toString("utf8");
        entries.push({ mode, hash, stage, fileName: Buffer.from(fileName, "utf8").equals(name) ? fileName : undefined });
        start = end + 1;
    }
    return entries;
}

/**
 * Only indexed bytes are normalized. A working file is updated when it still equals the indexed version; a partially
 * staged file is left alone, so its unstaged edits never become part of the commit. It can retain newline differences
 * against the normalized index until the user next stages it.
 */
export function formatStaged({ cwd = process.cwd() } = {}) {
    const repositoryRoot = git(cwd, ["rev-parse", "--show-toplevel"]).toString("utf8").trimEnd();
    const realRepositoryRoot = fs.realpathSync(repositoryRoot);
    const indexPath = path.resolve(repositoryRoot, git(repositoryRoot, ["rev-parse", "--git-path", "index"]).toString("utf8").trimEnd());
    const stagedIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath) : undefined;
    if (!stagedIndex) return [];
    const temporaryIndex = `${indexPath}.format-staged-${process.pid}-${randomUUID()}`;
    const lockPath = `${indexPath}.lock`;
    let lock;
    let ownsLock = false;
    try {
        fs.writeFileSync(temporaryIndex, stagedIndex, { flag: "wx" });
        const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
        const entries = indexEntries(git(repositoryRoot, ["ls-files", "--stage", "-z"], { env }));
        if (entries.some(entry => entry.stage !== "0")) throw new Error("Resolve staged merge conflicts before normalizing files.");
        const stagedPaths = git(repositoryRoot, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], { env }).toString("utf8").split("\0");
        const changed = new Set(stagedPaths);
        const updates = [];
        for (const entry of entries) {
            if (!changed.has(entry.fileName) || !["100644", "100755"].includes(entry.mode) || !isEligibleTextPath(entry.fileName)) continue;
            const content = git(repositoryRoot, ["cat-file", "blob", entry.hash], { env });
            const normalized = normalizedText(entry.fileName, content);
            if (!normalized || normalized.equals(content)) continue;
            const hash = git(repositoryRoot, ["hash-object", "-w", "--stdin"], { input: normalized, env }).toString("utf8").trim();
            updates.push({ ...entry, content, normalized, hash });
        }
        if (!updates.length) return [];
        const records = Buffer.from(updates.map(entry => `${entry.mode} ${entry.hash}\t${entry.fileName}\0`).join(""), "utf8");
        git(repositoryRoot, ["update-index", "-z", "--index-info"], { input: records, env });
        // Work on a private index, then take Git's normal lock and compare the original before installing it.
        // Concurrent staging is rejected rather than overwritten.
        lock = fs.openSync(lockPath, "wx");
        ownsLock = true;
        if (!fs.readFileSync(indexPath).equals(stagedIndex)) throw new Error("The Git index changed while files were being normalized. Retry the commit.");
        fs.writeFileSync(lock, fs.readFileSync(temporaryIndex));
        fs.closeSync(lock);
        lock = undefined;
        fs.renameSync(lockPath, indexPath);
        ownsLock = false;
        for (const update of updates) {
            const absolute = path.resolve(repositoryRoot, update.fileName);
            const relative = path.relative(repositoryRoot, absolute);
            if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
            try {
                if (!fs.lstatSync(absolute).isFile()) continue;
                const realRelative = path.relative(realRepositoryRoot, fs.realpathSync(absolute));
                if (realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) continue;
                if (fs.readFileSync(absolute).equals(update.content)) fs.writeFileSync(absolute, update.normalized);
            }
            catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        return updates.map(update => update.fileName);
    }
    finally {
        if (lock !== undefined) fs.closeSync(lock);
        // Never remove another Git process's lock when exclusive creation failed.
        if (ownsLock) fs.rmSync(lockPath, { force: true });
        fs.rmSync(temporaryIndex, { force: true });
        fs.rmSync(`${temporaryIndex}.lock`, { force: true });
    }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const files = formatStaged();
        if (files.length) console.log(`Normalized line endings/final newlines in ${files.length} staged file${files.length === 1 ? "" : "s"}.`);
    }
    catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
