// Assembles the playground site: a redirect at the root, the build of master at next/, and every release whose
// GitHub release carries a playground at v/<version>/. A release is only ever served from its own zip, so each version
// runs the code it was released with. The builds' Z3 directories, named by their content, move to one z3/ at the root,
// where builds with the same Z3 share it, and each build's deployment.json is pointed at the root. versions.json lists
// the releases for the version selector. The root redirects to the latest stable release, or to next/ before one exists.
// Usage: node scripts/assemble-site.mjs --next <dist> --releases <directory of tspp-playground-X.Y.Z.zip> --out <site>
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { compareVersions } from "../../../scripts/release-version.mjs";

const { unzipSync } = createRequire(import.meta.url)("fflate");
const { values: options } = parseArgs({ options: { next: { type: "string" }, releases: { type: "string" }, out: { type: "string" } } });
if (!options.next || !options.out) throw new Error("Usage: assemble-site.mjs --next <dist> [--releases <directory>] --out <site>");
const out = path.resolve(options.out);
const archive = /^tspp-playground-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\.zip$/;

function extract(zip, directory) {
  for (const [file, bytes] of Object.entries(unzipSync(fs.readFileSync(zip)))) {
    if (file.endsWith("/")) continue;
    const target = path.join(directory, file);
    if (!target.startsWith(directory + path.sep)) throw new Error(`${zip} names a file outside its build: ${file}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
}

/** Moves a build's Z3 directories to the site's shared z3/ and points its deployment.json at the root. */
function share(build) {
  const z3 = path.join(build, "z3");
  for (const hash of fs.existsSync(z3) ? fs.readdirSync(z3) : []) {
    const shared = path.join(out, "z3", hash);
    if (fs.existsSync(shared)) fs.rmSync(path.join(z3, hash), { recursive: true });
    else {
      fs.mkdirSync(path.dirname(shared), { recursive: true });
      fs.renameSync(path.join(z3, hash), shared);
    }
  }
  fs.rmSync(z3, { recursive: true, force: true });
  const file = path.join(build, "deployment.json");
  const deployment = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  deployment.sharedRoot = `${path.relative(build, out).split(path.sep).join("/")}/`;
  fs.writeFileSync(file, `${JSON.stringify(deployment, undefined, 2)}\n`);
}

const releases = (options.releases && fs.existsSync(options.releases) ? fs.readdirSync(options.releases) : [])
  .map(file => ({ file: path.join(options.releases, file), version: archive.exec(file)?.[1] }))
  .filter(release => release.version)
  .sort((a, b) => compareVersions(b.version, a.version));
const latest = releases.find(release => !release.version.includes("-"));

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const target = latest ? `./v/${latest.version}/` : "./next/";
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
fs.cpSync(options.next, path.join(out, "next"), { recursive: true });
share(path.join(out, "next"));
for (const release of releases) {
  const build = path.join(out, "v", release.version);
  extract(release.file, build);
  share(build);
}
const versions = { latest: latest?.version ?? null, releases: releases.map(release => release.version) };
fs.writeFileSync(path.join(out, "versions.json"), `${JSON.stringify(versions, undefined, 2)}\n`);

console.log(`Root redirects to ${target}`);
console.log(`Releases: ${versions.releases.join(", ") || "none"}`);
console.log(`Shared Z3: ${fs.readdirSync(path.join(out, "z3")).join(", ")}`);
