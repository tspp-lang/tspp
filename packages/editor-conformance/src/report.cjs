// Runs every check on every example and prints what it finds: `node src/report.cjs [--grammar|--tree|--service|--editing] [filter]`.
const { TsServer } = require("./tsserver.cjs");
const { exampleProjects } = require("./examples.cjs");
const { checkFileGrammar } = require("./grammar-checks.cjs");
const { inspectFile, checkConsistency, checkEditing } = require("./service-checks.cjs");
const { checkTree } = require("./tree-checks.cjs");
const { formatFindings } = require("./findings.cjs");
const { compareWithGaps, writeGaps } = require("./known-gaps.cjs");

const args = process.argv.slice(2);
const layers = args.filter(arg => arg.startsWith("--") && arg !== "--write-gaps").map(arg => arg.slice(2));
const filter = args.find(arg => !arg.startsWith("--"));
const wants = layer => !layers.length || layers.includes(layer);

async function main() {
  const findings = [];
  for (const project of exampleProjects()) {
    if (filter && !project.name.includes(filter)) continue;
    console.error(`checking ${project.name}`);
    if (wants("grammar")) for (const source of project.files) findings.push(...await checkFileGrammar(source.relative, source.text));
    if (wants("tree")) for (const source of project.files) findings.push(...await checkTree(project, source));
    if (wants("service")) {
      let server = new TsServer();
      const occurrences = [];
      for (const source of project.files) {
        if (server.exited) server = new TsServer();
        const inspected = await inspectFile(server, project, source);
        findings.push(...inspected.findings);
        occurrences.push(...inspected.occurrences);
      }
      server.stop();
      findings.push(...checkConsistency(occurrences));
    }
    if (wants("editing")) {
      let server = new TsServer();
      for (const source of project.files) {
        // A file that hangs the server must not hide what the other files would report.
        if (server.exited) server = new TsServer();
        console.error(`editing ${source.relative}`);
        findings.push(...await checkEditing(server, project, source));
      }
      server.stop();
    }
  }
  if (args.includes("--write-gaps")) writeGaps(findings);
  console.log(formatFindings(findings) || "No findings.");
  console.log(`\n${findings.length} findings.`);
  const differences = filter || layers.length ? [] : compareWithGaps(findings);
  if (differences.length) console.log(`\nDifferences from known-gaps.json:\n${differences.join("\n")}`);
  process.exit(differences.length ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(2);
});
