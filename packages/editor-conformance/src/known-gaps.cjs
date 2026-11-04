// Findings that are known and not fixed yet, by rule and file. They are listed so that they can only shrink: a new finding
// fails, and so does a gap that is gone, until it is removed here. Regenerate with `node src/report.cjs --write-gaps`.
const fs = require("node:fs");
const path = require("node:path");

const gapsFile = path.resolve(__dirname, "../known-gaps.json");

const readGaps = () => fs.existsSync(gapsFile) ? JSON.parse(fs.readFileSync(gapsFile, "utf8")) : {};

/** Findings grouped as `rule`, then `file`, then how many. */
function countFindings(findings) {
  const counts = {};
  for (const { rule, location } of findings) {
    const file = location.slice(0, location.lastIndexOf(":"));
    counts[rule] ??= {};
    counts[rule][file] = (counts[rule][file] ?? 0) + 1;
  }
  return counts;
}

/** How the findings differ from the known gaps of the layers `isChecked` accepts: more than known fails, and so does less. */
function compareWithGaps(findings, isChecked = () => true) {
  const known = readGaps();
  const found = countFindings(findings);
  const differences = [];
  for (const rule of new Set([...Object.keys(known), ...Object.keys(found)])) {
    if (!isChecked(rule)) continue;
    for (const file of new Set([...Object.keys(known[rule] ?? {}), ...Object.keys(found[rule] ?? {})])) {
      const [expected, actual] = [known[rule]?.[file] ?? 0, found[rule]?.[file] ?? 0];
      if (actual > expected) differences.push(`${rule} ${file}: ${actual} findings, known ${expected}`);
      else if (actual < expected) differences.push(`${rule} ${file}: fixed down to ${actual} from ${expected}; lower it in known-gaps.json`);
    }
  }
  return differences;
}

function writeGaps(findings) {
  fs.writeFileSync(gapsFile, `${JSON.stringify(countFindings(findings), null, 2)}\n`);
}

module.exports = { compareWithGaps, writeGaps };
