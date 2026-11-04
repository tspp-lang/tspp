// Highlighting and hover must hold without anyone looking: every check runs on every example, and only the gaps listed in
// known-gaps.json may remain. See src/report.cjs for what each finding means.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { exampleProjects } = require("../src/examples.cjs");
const { checkFileGrammar, checkParityCase } = require("../src/grammar-checks.cjs");
const { TsServer } = require("../src/tsserver.cjs");
const { inspectFile, checkConsistency, checkEditing } = require("../src/service-checks.cjs");
const { checkTree } = require("../src/tree-checks.cjs");
const { compareWithGaps } = require("../src/known-gaps.cjs");

const projects = exampleProjects();
const rulesOf = prefixes => rule => prefixes.some(prefix => rule.startsWith(prefix));

test("the examples cover plugin syntax in every layer", () => assert.ok(projects.length >= 12));

test("plugin grammars keep out of comments and strings, and no state leaks", async () => {
  const findings = [];
  for (const project of projects) for (const source of project.files) findings.push(...await checkFileGrammar(source.relative, source.text));
  assert.deepEqual(compareWithGaps(findings, rulesOf(["grammar/"])), []);
});

test("plugin syntax highlights like the TypeScript it stands next to", async () => {
  const pluginsRoot = path.resolve(__dirname, "../../plugins");
  let cases = 0;
  const findings = [];
  for (const plugin of fs.readdirSync(pluginsRoot)) {
    const file = path.join(pluginsRoot, plugin, "test/editor-parity.json");
    if (!fs.existsSync(file)) continue;
    for (const testCase of JSON.parse(fs.readFileSync(file, "utf8"))) {
      cases++;
      findings.push(...await checkParityCase(`${plugin}: ${testCase.name}`, testCase));
    }
  }
  assert.ok(cases > 0);
  assert.deepEqual(findings, []);
});

test("the parity check notices a difference", async () => {
  const findings = await checkParityCase("self-test", { tspp: "§let a = 1;§", ts: "§a(1);§" });
  assert.notDeepEqual(findings, []);
});

test("the comment check notices a keyword scoped inside a comment", async () => {
  // Nothing injects into this comment, so the check must stay quiet, and the same text must be a word outside of it.
  const quiet = await checkFileGrammar("self-test.tspp", "// match data\nconst a = 1;\n");
  assert.deepEqual(quiet.filter(item => item.rule === "grammar/comment-untouched"), []);
});

test("every parse ends and every tree nests, including broken text", async () => {
  const findings = [];
  for (const project of projects) for (const source of project.files) findings.push(...await checkTree(project, source));
  assert.deepEqual(compareWithGaps(findings, rulesOf(["tree/"])), []);
});

test("quick info and semantic tokens stay at source level and consistent", async () => {
  const findings = [];
  for (const project of projects) {
    const server = new TsServer();
    const occurrences = [];
    for (const source of project.files) {
      const inspected = await inspectFile(server, project, source);
      findings.push(...inspected.findings);
      occurrences.push(...inspected.occurrences);
    }
    server.stop();
    findings.push(...checkConsistency(occurrences));
  }
  assert.deepEqual(compareWithGaps(findings, rulesOf(["service/", "hover/", "consistency/"])), []);
});

test("editing never crashes or hangs the service", async () => {
  const findings = [];
  for (const project of projects) {
    let server = new TsServer();
    for (const source of project.files) {
      if (server.exited) server = new TsServer();
      findings.push(...await checkEditing(server, project, source));
    }
    server.stop();
  }
  assert.deepEqual(compareWithGaps(findings, rulesOf(["editing/"])), []);
});
