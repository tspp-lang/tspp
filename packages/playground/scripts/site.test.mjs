import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";

const assembler = path.join(import.meta.dirname, "assemble-site.mjs");

function preview(asset, z3 = "shared wasm") {
  return zipSync({
    "index.html": strToU8(`<body><select id="versions"></select><script src="./assets/${asset}.js"></script></body>`),
    [`assets/${asset}.js`]: strToU8(asset),
    "deployment.json": strToU8('{"sharedRoot":"./"}'),
    "z3/example/z3-built.wasm": strToU8(z3),
  });
}

test("a Dev publication preserves Master, its asset URLs, and stable releases", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-playground-site-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, "previews");
  const releases = path.join(root, "releases");
  fs.mkdirSync(input);
  fs.mkdirSync(releases);
  const master = preview("master-worker");
  const archive = (branch, bytes) => fs.writeFileSync(path.join(input, `${branch}.zip`), bytes);
  archive("master", master);
  fs.writeFileSync(path.join(releases, "tspp-playground-1.0.0.zip"), preview("release-worker"));
  fs.writeFileSync(path.join(releases, "tspp-playground-0.1.0.zip"), preview("archived-worker"));

  function assemble(number, runs, includeReleases = true) {
    const out = path.join(root, `site-${number}`);
    fs.writeFileSync(path.join(input, "runs.json"), JSON.stringify(runs));
    const args = [assembler, "--previews", input, "--deployment", `${number}-1`, "--out", out];
    if (includeReleases) args.push("--releases", releases);
    execFileSync(process.execPath, args, { stdio: "pipe" });
    return out;
  }

  const initial = assemble(1, { master: 20 }, false);
  assert.match(fs.readFileSync(path.join(initial, "index.html"), "utf8"), /href="\.\/master\/"/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(initial, "versions.json"))).branches, ["master"]);

  archive("dev", preview("dev-before"));
  const before = assemble(2, { master: 20, dev: 21 });
  const state = JSON.parse(fs.readFileSync(path.join(before, "preview-builds/2-1.json")));
  const publishedMaster = fs.readFileSync(path.join(before, "preview-builds", `master-${state.master.digest}.zip`));
  assert.ok(publishedMaster.equals(master));

  archive("master", publishedMaster);
  archive("dev", preview("dev-after"));
  const after = assemble(3, { master: 20, dev: 22 });
  for (const directory of ["master", "v/1.0.0", "v/0.1.0", "z3"]) {
    const files = fs.readdirSync(path.join(before, directory), { recursive: true }).sort();
    assert.deepEqual(fs.readdirSync(path.join(after, directory), { recursive: true }).sort(), files);
    for (const file of files) {
      const original = path.join(before, directory, file);
      if (fs.statSync(original).isFile()) assert.deepEqual(fs.readFileSync(path.join(after, directory, file)), fs.readFileSync(original));
    }
  }
  assert.match(fs.readFileSync(path.join(after, "dev/index.html"), "utf8"), /dev-after\.js/);
  assert.match(fs.readFileSync(path.join(after, "index.html"), "utf8"), /href="\.\/v\/1\.0\.0\/"/);
  assert.equal(fs.existsSync(path.join(after, "next")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(after, "versions.json"))).branches, ["master", "dev"]);
  assert.match(fs.readFileSync(path.join(after, "v/0.1.0/index.html"), "utf8"), /\)\(\["master","dev"\]\);<\/script>/);
  assert.doesNotMatch(fs.readFileSync(path.join(after, "v/1.0.0/index.html"), "utf8"), /updateArchivedSelector/);

  archive("dev", preview("dev-conflict", "different wasm at the same URL"));
  assert.throws(() => assemble(4, { master: 20, dev: 23 }), /Conflicting shared Z3 files/);
});
