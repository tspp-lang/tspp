import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { formatStaged, normalizedText } from "./format-staged.mjs";
import { installHooks, installPortableFormatHook } from "./install-lefthook.mjs";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-format-staged-"));
    t.after(() => {
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const git = (args, { input, allowFailure = false, env } = {}) => {
        const result = spawnSync("git", args, { cwd: root, input, env: env ?? process.env, maxBuffer: 16 * 1024 * 1024 });
        if (result.error) throw result.error;
        if (!allowFailure) assert.equal(result.status, 0, result.stderr.toString());
        return result.stdout;
    };
    git(["init", "--quiet"]);
    git(["config", "user.name", "Staged Formatter Test"]);
    git(["config", "user.email", "formatter-test@example.invalid"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.safecrlf", "false"]);
    git(["config", "core.hooksPath", ".git/hooks"]);
    const write = (relative, content) => {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    const read = relative => fs.readFileSync(path.join(root, relative));
    const stage = relative => git(["add", "--", relative]);
    const blob = relative => git(["show", `:${relative}`]);
    const commit = () => git(["-c", "core.hooksPath=", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
    return { root, git, write, read, stage, blob, commit };
}

test("normalizes only staged text using LF outside compiler scripts and CRLF inside them", t => {
    const f = fixture(t);
    const files = new Map([
        ["src/space name.ts", ["const   value=1\r\nconst next=2\r", "const   value=1\nconst next=2\n"]],
        ["packages/compiler/src/sample.ts", ["const value = 1;\nconst next = 2;", "const value = 1;\r\nconst next = 2;\r\n"]],
        ["packages/compiler/package.json", ['{"name":"test"}\r\n', '{"name":"test"}\n']],
        ["examples/demo.tspp", ["data A = One;\r\n", "data A = One;\n"]],
        ["docs/中文 guide.md", ["# Guide\r\n\r\nText  ", "# Guide\n\nText  \n"]],
    ]);
    for (const [name, [before]] of files) { f.write(name, before); f.stage(name); }
    f.write("unstaged.ts", "const unstaged = 1;\r\n");
    assert.deepEqual(formatStaged({ cwd: f.root }).sort(), [...files.keys()].sort());
    for (const [name, [, after]] of files) {
        assert.equal(f.blob(name).toString(), after);
        assert.equal(f.read(name).toString(), after);
    }
    assert.equal(f.read("unstaged.ts").toString(), "const unstaged = 1;\r\n");
    assert.deepEqual(formatStaged({ cwd: f.root }), []);
});

test("partially staged files normalize the indexed version without staging or rewriting unstaged edits", t => {
    const f = fixture(t);
    f.write("partial.ts", "const original = 0;\n");
    f.stage("partial.ts");
    f.commit();
    f.write("partial.ts", "const staged = 1;\r\n");
    f.stage("partial.ts");
    const working = Buffer.from("const staged = 1;\r\nconst unstaged = 2;\r\n");
    f.write("partial.ts", working);
    assert.deepEqual(formatStaged({ cwd: f.root }), ["partial.ts"]);
    assert.equal(f.blob("partial.ts").toString(), "const staged = 1;\n");
    assert.deepEqual(f.read("partial.ts"), working);
    assert.match(f.git(["diff", "--", "partial.ts"]).toString(), /const unstaged = 2/);
});

test("binary, non-UTF8, generated, upstream tests, lockfiles, and unknown extensions are preserved", t => {
    const f = fixture(t);
    const files = new Map([
        ["binary.ts", Buffer.from([0, 13, 10, 255])],
        ["invalid-utf8.ts", Buffer.from([0xc3, 0x28, 13, 10])],
        ["packages/compiler/tests/cases/example.ts", Buffer.from("baseline\r\n")],
        ["packages/compiler/lib/lib.d.ts", Buffer.from("generated\r\n")],
        ["packages/compiler/src/compiler/_namespaces/ts.ts", Buffer.from("generated\r\n")],
        ["src/file.generated.ts", Buffer.from("generated\r\n")],
        ["src/fixtures/input.ts", Buffer.from("fixture\r\n")],
        ["pnpm-lock.yaml", Buffer.from("lockfile\r\n")],
        ["image.bin", Buffer.from("binary-like\r\n")],
    ]);
    for (const [name, bytes] of files) { f.write(name, bytes); f.stage(name); }
    assert.deepEqual(formatStaged({ cwd: f.root }), []);
    for (const [name, bytes] of files) {
        assert.deepEqual(f.blob(name), bytes);
        assert.deepEqual(f.read(name), bytes);
    }
});

test("large excluded assets are skipped before reading their blobs", t => {
    const f = fixture(t);
    const binary = Buffer.alloc(65 * 1024 * 1024);
    f.write("large-asset.bin", binary);
    f.stage("large-asset.bin");
    f.write("packages/compiler/tests/large.generated.ts", binary);
    f.stage("packages/compiler/tests/large.generated.ts");
    const before = f.git(["ls-files", "--stage", "-z"]);
    assert.deepEqual(formatStaged({ cwd: f.root }), []);
    assert.deepEqual(f.git(["ls-files", "--stage", "-z"]), before);
});

test("preserves executable, symlink, submodule, rename and deletion entries", t => {
    const f = fixture(t);
    f.write("deleted.txt", "delete me\n");
    f.write("old name.txt", "rename me\n");
    f.stage("deleted.txt");
    f.stage("old name.txt");
    f.commit();
    const commitHash = f.git(["rev-parse", "HEAD"]).toString().trim();
    fs.rmSync(path.join(f.root, "deleted.txt"));
    f.git(["add", "-u", "--", "deleted.txt"]);
    f.git(["mv", "--", "old name.txt", "new name.txt"]);
    f.write("new name.txt", "rename me\r\n");
    f.stage("new name.txt");
    f.write("run.sh", "#!/bin/sh\r\necho hello");
    f.stage("run.sh");
    f.git(["update-index", "--chmod=+x", "--", "run.sh"]);
    const target = Buffer.from("target\r\n");
    const symlinkHash = f.git(["hash-object", "-w", "--stdin"], { input: target }).toString().trim();
    f.git(["update-index", "--add", "--cacheinfo", `120000,${symlinkHash},link.txt`]);
    f.git(["update-index", "--add", "--cacheinfo", `160000,${commitHash},submodule`]);
    assert.deepEqual(formatStaged({ cwd: f.root }).sort(), ["new name.txt", "run.sh"]);
    const entries = f.git(["ls-files", "--stage"]).toString();
    assert.match(entries, /100755 [a-f0-9]+ 0\trun.sh/);
    assert.match(entries, new RegExp(`120000 ${symlinkHash} 0\\tlink.txt`));
    assert.match(entries, new RegExp(`160000 ${commitHash} 0\\tsubmodule`));
    assert.doesNotMatch(entries, /deleted\.txt|old name\.txt/);
    assert.equal(f.blob("new name.txt").toString(), "rename me\n");
});

test("merge conflicts reject normalization before any staged or working file is changed", t => {
    const f = fixture(t);
    f.write("normal.ts", "const value = 1;\r\n");
    f.stage("normal.ts");
    const hash = f.git(["hash-object", "-w", "--stdin"], { input: Buffer.from("conflict\r\n") }).toString().trim();
    f.git(["update-index", "--index-info"], { input: `100644 ${hash} 1\tconflict.ts\n100644 ${hash} 2\tconflict.ts\n100644 ${hash} 3\tconflict.ts\n` });
    const before = f.git(["ls-files", "--stage", "-z"]);
    assert.throws(() => formatStaged({ cwd: f.root }), /Resolve staged merge conflicts/);
    assert.deepEqual(f.git(["ls-files", "--stage", "-z"]), before);
    assert.equal(f.read("normal.ts").toString(), "const value = 1;\r\n");
    assert.equal(f.blob("normal.ts").toString(), "const value = 1;\r\n");
});

test("an existing index lock is preserved and prevents staged or working changes", t => {
    const f = fixture(t);
    f.write("normal.ts", "const value = 1;\r\n");
    f.stage("normal.ts");
    const lock = path.join(f.root, ".git", "index.lock");
    fs.writeFileSync(lock, "another Git process");
    assert.throws(() => formatStaged({ cwd: f.root }), /EEXIST/);
    assert.equal(fs.readFileSync(lock, "utf8"), "another Git process");
    assert.equal(f.blob("normal.ts").toString(), "const value = 1;\r\n");
    assert.equal(f.read("normal.ts").toString(), "const value = 1;\r\n");
    assert.deepEqual(fs.readdirSync(path.join(f.root, ".git")).filter(name => name.includes("format-staged")), []);
});

test("concurrent staging is preserved instead of overwritten by the normalized index", t => {
    const f = fixture(t);
    f.write("normal.ts", "const value = 1;\r\n");
    f.stage("normal.ts");
    const open = fs.openSync;
    const lock = path.join(f.root, ".git", "index.lock");
    try {
        fs.openSync = (file, flags, ...args) => {
            if (file === lock && flags === "wx") {
                fs.openSync = open;
                f.write("concurrent.ts", "const concurrent = 2;\n");
                f.stage("concurrent.ts");
            }
            return open(file, flags, ...args);
        };
        assert.throws(() => formatStaged({ cwd: f.root }), /Git index changed/);
    }
    finally {
        fs.openSync = open;
    }
    assert.equal(f.blob("normal.ts").toString(), "const value = 1;\r\n");
    assert.equal(f.blob("concurrent.ts").toString(), "const concurrent = 2;\n");
    assert.equal(fs.existsSync(lock), false);
});

test("respects an alternate Git index without changing the repository's main index", t => {
    const f = fixture(t);
    f.write("normal.ts", "const main = 1;\n");
    f.stage("normal.ts");
    const alternate = path.join(f.root, ".git", "alternate-index");
    fs.copyFileSync(path.join(f.root, ".git", "index"), alternate);
    f.write("normal.ts", "const alternate = 2;\r\n");
    const env = { ...process.env, GIT_INDEX_FILE: alternate };
    f.git(["add", "--", "normal.ts"], { env });
    const previous = process.env.GIT_INDEX_FILE;
    try {
        process.env.GIT_INDEX_FILE = alternate;
        assert.deepEqual(formatStaged({ cwd: f.root }), ["normal.ts"]);
    }
    finally {
        if (previous === undefined) delete process.env.GIT_INDEX_FILE;
        else process.env.GIT_INDEX_FILE = previous;
    }
    assert.equal(f.blob("normal.ts").toString(), "const main = 1;\n");
    assert.equal(f.git(["show", ":normal.ts"], { env }).toString(), "const alternate = 2;\n");
});

test("preserves a UTF-8 BOM, empty files, and meaningful trailing spaces", () => {
    assert.equal(normalizedText("bom.md", Buffer.from("\ufeffhello  \r\n")).toString(), "\ufeffhello  \n");
    assert.deepEqual(normalizedText("empty.ts", Buffer.alloc(0)), Buffer.alloc(0));
});

test("an installed Lefthook pre-commit hook normalizes the commit without staging partial edits", t => {
    const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout?.match(/git version (\d+)\.(\d+)/);
    if (!version || Number(version[1]) < 2 || Number(version[1]) === 2 && Number(version[2]) < 31) {
        t.skip("Lefthook requires Git 2.31+, matching scripts/install-lefthook.mjs.");
        return;
    }
    const f = fixture(t);
    const require = createRequire(import.meta.url);
    const binary = require("lefthook/get-exe.js").getExePath();
    f.write("scripts/format-staged.mjs", fs.readFileSync(new URL("./format-staged.mjs", import.meta.url)));
    f.write("lefthook.yml", "pre-commit:\n  commands:\n    normalize-staged:\n      run: node scripts/format-staged.mjs\n");
    f.stage("scripts/format-staged.mjs");
    f.stage("lefthook.yml");
    f.commit();
    const env = { ...process.env, LEFTHOOK: "1", LEFTHOOK_BIN: binary };
    const installation = spawnSync(binary, ["install", "--force"], { cwd: f.root, env });
    assert.equal(installation.status, 0, installation.stderr?.toString());
    f.write("partial.ts", "const staged = 1;\r\n");
    f.stage("partial.ts");
    const working = "const staged = 1;\r\nconst unstaged = 2;\r\n";
    f.write("partial.ts", working);
    f.git(["commit", "--quiet", "-m", "hook integration"], { env });
    assert.equal(f.git(["show", "HEAD:partial.ts"]).toString(), "const staged = 1;\n");
    // Lefthook hides and restores partial edits around its commands, so the staged line may already use LF.
    assert.ok(f.read("partial.ts").toString().endsWith("const unstaged = 2;\r\n"));
    assert.match(f.git(["diff", "--", "partial.ts"]).toString(), /const unstaged = 2/);
});

test("the portable fallback hook respects custom hooks paths, is idempotent, and preserves partial edits", t => {
    const f = fixture(t);
    f.git(["config", "core.hooksPath", "custom hooks"]);
    f.write("scripts/format-staged.mjs", fs.readFileSync(new URL("./format-staged.mjs", import.meta.url)));
    f.stage("scripts/format-staged.mjs");
    f.commit();
    const hook = installPortableFormatHook({ cwd: f.root });
    assert.equal(hook, path.join(f.root, "custom hooks", "pre-commit"));
    assert.equal(installPortableFormatHook({ cwd: f.root }), hook);
    f.write("partial.ts", "const staged = 1;\r\n");
    f.stage("partial.ts");
    const working = "const staged = 1;\r\nconst unstaged = 2;\r\n";
    f.write("partial.ts", working);
    f.git(["commit", "--quiet", "-m", "portable hook integration"]);
    assert.equal(f.git(["show", "HEAD:partial.ts"]).toString(), "const staged = 1;\n");
    assert.equal(f.read("partial.ts").toString(), working);
});

test("the portable fallback installer refuses to overwrite a custom hook", t => {
    const f = fixture(t);
    const hook = path.join(f.root, ".git", "hooks", "pre-commit");
    fs.writeFileSync(hook, "#!/bin/sh\necho custom\n");
    assert.throws(() => installPortableFormatHook({ cwd: f.root }), /Preserving the existing hook/);
    assert.equal(fs.readFileSync(hook, "utf8"), "#!/bin/sh\necho custom\n");
});

test("the installer selects the portable hook when the current Git predates 2.31", t => {
    const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout?.match(/git version (\d+)\.(\d+)/);
    if (!version || Number(version[1]) > 2 || Number(version[1]) === 2 && Number(version[2]) >= 31) {
        t.skip("The main legacy-Git installation branch requires Git older than 2.31; the portable helper is tested on every version.");
        return;
    }
    const f = fixture(t);
    const messages = [];
    const status = installHooks({ cwd: f.root, env: { ...process.env, CI: "" }, log: { log: message => messages.push(message) } });
    assert.equal(status, 0);
    assert.match(messages.join("\n"), /Installed the staged newline normalization hook/);
    assert.match(fs.readFileSync(path.join(f.root, ".git", "hooks", "pre-commit"), "utf8"), /tspp-format-staged-hook/);
});
