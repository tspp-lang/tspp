// Parses the mutations of one file for tree-checks.cjs and reports the first way each tree breaks.
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
const { mutate } = require("./tree-mutations.cjs");
const ts = require(path.resolve(__dirname, "../../compiler/built/local/typescript.js"));

const { root, file, text, points, startIndex } = workerData;

/**
 * Generated nodes without a source position are skipped by every token walk, so only positioned ones must nest.
 * Source order of siblings is not required: `f(x, () => rest)` lowered from `use x <- f(x)` can't keep it.
 */
const isPositioned = node => node.pos >= 0 && node.end >= 0;
const kindOf = node => ts.SyntaxKind[node.kind];
const range = node => `${kindOf(node)} [${node.pos},${node.end}]`;

function treeViolation(sourceFile) {
  let violation;
  const visit = (node, parent) => {
    if (isPositioned(node)) {
      if (node.pos > node.end) violation = `${range(node)} ends before it starts`;
      else if (parent && isPositioned(parent) && (node.pos < parent.pos || node.end > parent.end)) violation = `${range(node)} is outside its parent ${range(parent)}`;
    }
    ts.forEachChild(node, child => {
      if (!violation) visit(child, node);
    });
  };
  visit(sourceFile);
  return violation;
}

const configFile = path.join(root, "tsconfig.json");
const { options } = ts.parseJsonConfigFileContent(ts.readConfigFile(configFile, ts.sys.readFile).config, ts.sys, root);
ts.loadTSPPConfiguredPlugins(options, configFile, ts.sys);
if (!ts.getActiveTSPPPlugins().length) throw new Error(`No TS++ plugins active for ${root}.`);

for (let index = startIndex; index < points.length; index++) {
  parentPort.postMessage({ index });
  const candidate = mutate(text, points[index]);
  const violation = treeViolation(ts.createSourceFile(file, candidate, ts.ScriptTarget.Latest, /*setParentNodes*/ true));
  if (violation) parentPort.postMessage({ violation });
}
parentPort.postMessage({ done: true });
