// Assembles branch previews, archived releases, and the shared Z3 assets into a single Pages site.
// Preview zips also travel with the site so a later deployment can reuse them byte for byte.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { compareVersions } from "../../../scripts/release-version.mjs";

const { unzipSync } = createRequire(import.meta.url)("fflate");
const { values: options } = parseArgs({ options: {
  previews: { type: "string" }, deployment: { type: "string" }, releases: { type: "string" }, out: { type: "string" },
} });
if (!options.previews || !options.out || !/^\d+-\d+$/.test(options.deployment ?? "")) {
  throw new Error("Usage: assemble-site.mjs --previews <directory> --deployment <run-id>-<attempt> [--releases <directory>] --out <site>");
}
const out = path.resolve(options.out);
const archive = /^tspp-playground-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.zip$/;
const runs = JSON.parse(fs.readFileSync(path.join(options.previews, "runs.json"), "utf8"));
const branches = ["master", "dev"].filter(branch => Object.hasOwn(runs, branch));
if (!branches.includes("master") || branches.some(branch => !Number.isSafeInteger(runs[branch]) || runs[branch] < 1)) {
  throw new Error("Preview runs must include a valid master run number and may include a dev run number.");
}

function extract(zip, directory) {
  for (const [file, bytes] of Object.entries(unzipSync(zip))) {
    if (file.endsWith("/")) continue;
    const target = path.join(directory, file);
    if (!target.startsWith(directory + path.sep)) throw new Error(`Preview or release names a file outside its build: ${file}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

function sameFiles(left, right) {
  const files = fs.readdirSync(left, { recursive: true }).sort();
  const otherFiles = fs.readdirSync(right, { recursive: true }).sort();
  return files.length === otherFiles.length && files.every((file, index) => {
    if (file !== otherFiles[index]) return false;
    const a = path.join(left, file);
    const b = path.join(right, file);
    if (fs.statSync(a).isDirectory()) return fs.statSync(b).isDirectory();
    return fs.statSync(b).isFile() && fs.readFileSync(a).equals(fs.readFileSync(b));
  });
}

/** Moves a build's Z3 directories to the site's shared z3/ and points its deployment.json at the root. */
function share(build) {
  const z3 = path.join(build, "z3");
  for (const hash of fs.existsSync(z3) ? fs.readdirSync(z3) : []) {
    const shared = path.join(out, "z3", hash);
    const source = path.join(z3, hash);
    if (fs.existsSync(shared)) {
      if (!sameFiles(source, shared)) throw new Error(`Conflicting shared Z3 files for ${hash}.`);
    }
    else {
      fs.mkdirSync(path.dirname(shared), { recursive: true });
      fs.renameSync(source, shared);
    }
  }
  fs.rmSync(z3, { recursive: true, force: true });
  const file = path.join(build, "deployment.json");
  const deployment = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  deployment.sharedRoot = `${path.relative(build, out).split(path.sep).join("/")}/`;
  fs.writeFileSync(file, `${JSON.stringify(deployment, undefined, 2)}\n`);
}

// v0.1.0 fills the dropdown asynchronously with a hard-coded preview followed by the releases.
// Replace that preview in the page, leaving the archived compiler and release links intact.
function updateArchivedSelector(branches) {
  const select = document.getElementById("versions");
  const observer = new MutationObserver(update);
  observer.observe(select, { childList: true });
  update();

  function update() {
    const preview = select.firstElementChild;
    if (!preview) return;
    observer.disconnect();
    const currentVersion = select.value;
    const selectRelease = select.onchange;
    preview.replaceWith(...branches.map(branch => new Option(branch === "master" ? "Master" : "Dev", branch)));
    select.onchange = event => {
      const branch = select.value;
      if (!branches.includes(branch)) return selectRelease.call(select, event);
      if (document.querySelector("#tabs .tab.dirty") && !confirm("Discard all unsaved changes and open another version?")) {
        select.value = currentVersion;
        return;
      }
      location.href = new URL(`../../${branch}/`, document.baseURI).href + location.search + location.hash;
    };
  }
}

const releases = (options.releases && fs.existsSync(options.releases) ? fs.readdirSync(options.releases) : [])
  .map(file => ({ file: path.join(options.releases, file), version: archive.exec(file)?.[1] }))
  .filter(release => release.version)
  .sort((a, b) => compareVersions(b.version, a.version));
const latest = releases.find(release => !release.version.includes("-"));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const target = latest ? `./v/${latest.version}/` : "./master/";
fs.writeFileSync(path.join(out, "index.html"), `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>TS++ Playground</title>
</head>
<body>
  <a id="playground-link" href="${target}">Open the TS++ Playground</a>
  <script>
    location.replace(document.getElementById("playground-link").href + location.search + location.hash);
  </script>
</body>
</html>
`);

const archives = path.join(out, "preview-builds");
fs.mkdirSync(archives);
const previews = Object.fromEntries(branches.map(branch => {
  const zip = fs.readFileSync(path.join(options.previews, `${branch}.zip`));
  const digest = createHash("sha256").update(zip).digest("hex");
  const build = path.join(out, branch);
  extract(zip, build);
  if (!fs.existsSync(path.join(build, "index.html"))) throw new Error(`The ${branch} preview has no index.html.`);
  share(build);
  fs.writeFileSync(path.join(archives, `${branch}-${digest}.zip`), zip);
  return [branch, { run: runs[branch], digest }];
}));
fs.writeFileSync(path.join(archives, `${options.deployment}.json`), JSON.stringify(previews) + "\n");

for (const release of releases) {
  const build = path.join(out, "v", release.version);
  extract(fs.readFileSync(release.file), build);
  share(build);
  if (release.version === "0.1.0") {
    const page = path.join(build, "index.html");
    const html = fs.readFileSync(page, "utf8");
    if (!html.includes("</body>")) throw new Error("Could not update the version selector in the v0.1.0 page.");
    const script = `<script>(${updateArchivedSelector.toString()})(${JSON.stringify(branches)});</script>`;
    fs.writeFileSync(page, html.replace("</body>", () => `${script}\n</body>`));
  }
}
const versions = { latest: latest?.version ?? null, branches, releases: releases.map(release => release.version) };
fs.writeFileSync(path.join(out, "versions.json"), `${JSON.stringify(versions, undefined, 2)}\n`);

console.log(`Root redirects to ${target}`);
console.log(`Releases: ${versions.releases.join(", ") || "none"}`);
console.log(`Branch previews: ${branches.join(", ")}`);
