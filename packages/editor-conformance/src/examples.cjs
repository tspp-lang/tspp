// The sources everything is checked against: every TS++ file of every example project.
const fs = require("node:fs");
const path = require("node:path");

const examplesRoot = path.resolve(__dirname, "../../examples");

function sourcesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : sourcesUnder(full);
    return entry.name.endsWith(".tspp") ? [full] : [];
  });
}

function exampleProjects() {
  return fs.readdirSync(examplesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(examplesRoot, entry.name, "tsconfig.json")))
    .map(entry => {
      const root = path.join(examplesRoot, entry.name);
      return { name: entry.name, root, files: sourcesUnder(root).sort().map(file => ({ file, relative: path.relative(examplesRoot, file).replaceAll("\\", "/"), text: fs.readFileSync(file, "utf8") })) };
    })
    .filter(project => project.files.length);
}

module.exports = { exampleProjects, examplesRoot };
