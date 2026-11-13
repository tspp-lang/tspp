import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { skillFiles, syncSkills } from "./build-skills.mjs";

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-skills-test-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const write = (relative, content) => {
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    write("package.json", JSON.stringify({ version: "1.2.3-beta.1" }));
    write("scripts/skills-entry.md", "version {{version}}\n{{features}}\n");
    const source = "packages/plugins/example/skills";
    write(`${source}/SKILL.md`, "---\nname: tspp-example\ndescription: Example syntax and diagnostics.\n---\n");
    const collect = () => skillFiles({ repositoryRoot: root, pluginPackages: ["@tspp/plugin-example"] });
    return { root, write, source, collect, output: path.join(root, "skills", "tspp") };
}

test("copies nested resources, preserves internal links and pins repository references to the release", t => {
    const { write, source, collect } = fixture(t);
    write("docs/guide.md", "# Guide\n");
    write(`${source}/references/nested/topic.md`, "[home](../../SKILL.md)\n");
    write(`${source}/asset.bin`, Buffer.from([0, 128, 255]));
    write(`${source}/references/links.md`, [
        "[nested](nested/topic.md#syntax)",
        "[guide](../../../../../docs/guide.md#detail)",
        "[directory](../../../../../docs/)",
        "[ref]: ../../../../../docs/guide.md \"Guide\"",
        "[web](https://example.com/) [anchor](#here)",
        "```md", "[example](missing-example.md)", "```", "",
    ].join("\r\n"));
    const files = collect();
    const links = files.get("references/example/references/links.md").toString();
    assert.ok(links.includes("[nested](nested/topic.md#syntax)"));
    assert.ok(links.includes("https://github.com/tspp-lang/tspp/blob/v1.2.3-beta.1/docs/guide.md#detail"));
    assert.ok(links.includes("https://github.com/tspp-lang/tspp/tree/v1.2.3-beta.1/docs"));
    assert.ok(links.includes('[ref]: https://github.com/tspp-lang/tspp/blob/v1.2.3-beta.1/docs/guide.md "Guide"'));
    assert.ok(links.includes("[example](missing-example.md)"));
    assert.ok(!links.includes("\r"));
    assert.deepEqual(files.get("references/example/asset.bin"), Buffer.from([0, 128, 255]));
    assert.ok(files.get("SKILL.md").toString().includes("references/example/SKILL.md"));
});

test("fails on missing capsule skills, invalid metadata and broken references before changing output", t => {
    const { root, write, source, collect } = fixture(t);
    const entry = fs.readFileSync(path.join(root, source, "SKILL.md"), "utf8");
    write(`${source}/SKILL.md`, `${entry}\n[missing](references/missing.md)\n`);
    assert.throws(collect, /Missing or out-of-repository/);
    write(`${source}/SKILL.md`, entry.replace("name: tspp-example", "name: wrong"));
    assert.throws(collect, /needs name/);
    fs.unlinkSync(path.join(root, source, "SKILL.md"));
    assert.throws(collect, /Missing capsule skill/);
});

test("rejects YAML scalars, duplicate fields and comments that would change installed metadata", t => {
    const { write, source, collect } = fixture(t);
    for (const description of ["true", "42", "null", "[one, two]", "Write code # hidden comment"]) {
        write(`${source}/SKILL.md`, `---\nname: tspp-example\ndescription: ${description}\n---\n`);
        assert.throws(collect, /plain, single-line description/, description);
    }
    write(`${source}/SKILL.md`, "---\nname: tspp-example\ndescription: First description.\ndescription: Second description.\n---\n");
    assert.throws(collect, /exactly one/);
});

test("check detects edits, missing files and obsolete resources without modifying them; generation repairs them", t => {
    const { write, source, collect, output } = fixture(t);
    write(`${source}/references/detail.md`, "first\n");
    const original = collect();
    syncSkills(original, output);
    fs.writeFileSync(path.join(output, "SKILL.md"), "manually edited\n");
    fs.unlinkSync(path.join(output, "references/example/SKILL.md"));
    fs.mkdirSync(path.join(output, "references/removed"));
    fs.writeFileSync(path.join(output, "references/removed/old.md"), "stale\n");
    const result = syncSkills(original, output, { check: true });
    assert.deepEqual(result.changed.sort(), ["SKILL.md", "references/example/SKILL.md"].sort());
    assert.deepEqual(result.stale, ["references/removed/old.md"]);
    assert.equal(fs.readFileSync(path.join(output, "SKILL.md"), "utf8"), "manually edited\n");
    assert.ok(fs.existsSync(path.join(output, "references/removed/old.md")));
    syncSkills(original, output);
    assert.ok(!fs.existsSync(path.join(output, "references/removed")));
    assert.deepEqual(syncSkills(original, output, { check: true }), { changed: [], stale: [] });
    assert.deepEqual(syncSkills(original, output), { changed: [], stale: [] });
});

test("version and plugin changes invalidate the generated entry and remove obsolete capsule content", t => {
    const { root, write, collect, output } = fixture(t);
    syncSkills(collect(), output);
    write("package.json", JSON.stringify({ version: "1.2.4" }));
    assert.ok(syncSkills(collect(), output, { check: true }).changed.includes("SKILL.md"));
    const removed = skillFiles({ repositoryRoot: root, pluginPackages: [] });
    assert.ok(syncSkills(removed, output, { check: true }).stale.includes("references/example/SKILL.md"));
    syncSkills(removed, output);
    assert.ok(!fs.existsSync(path.join(output, "references")));
});

test("rejects external paths and symlinked resources or outputs", t => {
    const { root, write, source, collect, output } = fixture(t);
    const entry = fs.readFileSync(path.join(root, source, "SKILL.md"), "utf8");
    write(`${source}/SKILL.md`, `${entry}\n[external](../../../../../outside.md)\n`);
    assert.throws(collect, /Missing or out-of-repository/);
    write(`${source}/SKILL.md`, `${entry}\n[absolute](file:///tmp/guide.md)\n`);
    assert.throws(collect, /Use relative or HTTPS/);
    write(`${source}/SKILL.md`, entry);
    const external = path.join(root, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "keep.md"), "keep\n");
    const linked = path.join(root, source, "linked");
    try {
        fs.symlinkSync(external, linked, process.platform === "win32" ? "junction" : "dir");
    }
    catch (error) {
        if (error.code === "EPERM") return t.skip("Creating symlinks is not permitted on this host.");
        throw error;
    }
    assert.throws(collect, /not links or special files/);
    fs.unlinkSync(linked);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.symlinkSync(external, output, process.platform === "win32" ? "junction" : "dir");
    assert.throws(() => syncSkills(collect(), output), /Expected a real directory/);
    assert.equal(fs.readFileSync(path.join(external, "keep.md"), "utf8"), "keep\n");
});

test("CLI exits nonzero on stale output without repairing it, then accepts regenerated files", t => {
    const { root, write, output } = fixture(t);
    const scripts = path.dirname(fileURLToPath(import.meta.url));
    for (const file of ["build-skills.mjs", "plugin-entries.mjs"]) {
        write(`scripts/${file}`, fs.readFileSync(path.join(scripts, file)));
    }
    write("packages/compiler/package.json", JSON.stringify({ dependencies: { "@tspp/plugin-example": "workspace:*" } }));
    const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts/build-skills.mjs"), ...args], { encoding: "utf8" });
    const missing = run("--check");
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stderr, /pnpm build:skills/);
    assert.ok(!fs.existsSync(output));
    const generated = run();
    assert.equal(generated.status, 0, generated.stderr);
    assert.equal(run("--check").status, 0);
    fs.writeFileSync(path.join(output, "SKILL.md"), "manual edit\n");
    assert.equal(run("--check").status, 1);
    assert.equal(fs.readFileSync(path.join(output, "SKILL.md"), "utf8"), "manual edit\n");
});

test("the real template and every shipped capsule can be collected without built plugins or network access", () => {
    const files = skillFiles();
    assert.ok(files.size > 1);
    assert.ok(files.get("SKILL.md").toString().startsWith("---\nname: tspp\n"));
    // Every capsule reference has a matching source tree; collection validates all maintained Markdown links.
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    for (const file of files.keys()) {
        if (file === "SKILL.md") continue;
        const [, id, ...relative] = file.split("/");
        assert.ok(fs.existsSync(path.join(root, "packages/plugins", id, "skills", ...relative)));
    }
});
