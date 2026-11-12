// Measures how far a package derived from upstream has drifted from its baseline (docs/plugin-framework.md, "Core
// modification rules" and "Language server modification rules"). Upstream files may only change at slot call sites
// marked `TSPP-SLOT(<slot>)`; this reports the changed lines per upstream file, the hunks without that marker, and how
// often feature terms still appear in the added lines.
// Usage: node scripts/core-diff.mjs [--target core|lsp] [--base <ref>] [--json] [--check]
//
// With --check (CI), it exits non-zero when an upstream file has a hunk without the marker, a hunk too long to be a call
// site, or when the changed lines exceed the target's `budget`. Lower a budget when its package shrinks; raising it needs
// the review that a new slot needs.
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const slotMarker = /TSPP-SLOT\([\w-]+\)/;

// A call site forwards in a few lines. A longer hunk must be a known exception of its target.
const maxHunkAdded = 15;

const coreDir = "packages/compiler/src";
const lspDir = "packages/language-server/src";
const targets = {
    core: {
        name: "Core",
        dir: coreDir,
        base: "tspp-core-baseline",
        // Product code that lives in new files (or tests of it) is not a cost against upstream.
        counted: file => ![`${coreDir}/testRunner/`, `${coreDir}/compiler/tspp/`, `${coreDir}/services/tspp/`, `${coreDir}/server/tspp/`].some(prefix => file.startsWith(prefix)),
        excluded: "tests and tspp/ directories excluded",
        featureTerms: [
            "macro", "taggedUnion", "nominal", "newtype", "higherKinded", "typeConstructor", "universe", "reified", "mltt",
            "typeMatch", "operatorSection", "staticInterface", "trailingClosure", "completionBlock", "withClause", "tspp",
        ],
        // Two syntax-extension call sites beyond the +344 baseline: recognize lowered parameters despite overlapping
        // ranges, and print synthesized private field names from plugin syntax without reading nonexistent source text.
        // The formatting slot adds four: its import and the three formatting entry points of the language service. One more
        // keeps a syntax-extension call site in utilities.ts on its own line, as dprint requires. The rest let the printer
        // treat what plugin syntax lowers to as generated: it reads no source comments past the node it writes or at a
        // generated node, and it lays generated nodes out without the source lines of the place they were moved to.
        budget: { upstreamFiles: 25, upstreamAdded: 359, upstreamRemoved: 61 },
        // The parser's cursor for plugin syntax reads the parser's closure, so it cannot move to a new file.
        longHunkExceptions: [{ file: `${coreDir}/compiler/parser.ts`, contains: "createTSPPSyntaxCursor", maxAdded: 70 }],
    },
    lsp: {
        name: "Language server",
        dir: lspDir,
        base: "tspp-lsp-baseline",
        // TS++ logic lives in src/tspp/; tests are not shipped and follow the server's behaviour.
        counted: file => !file.startsWith(`${lspDir}/tspp/`) && !file.endsWith(".test.ts"),
        excluded: "tests and src/tspp/ excluded",
        featureTerms: ["tspp", "pluginSet", "vscode"],
        // The import of typescript-language-server 6.0.1 plus the call sites in docs/plugin-framework.md, "Language server
        // modification rules".
        budget: { upstreamFiles: 9, upstreamAdded: 36, upstreamRemoved: 21 },
        longHunkExceptions: [],
    },
};

const args = process.argv.slice(2);
const targetName = valueOf("--target") ?? "core";
const target = targets[targetName];
if (!target) throw new Error(`Unknown target '${targetName}'; expected one of ${Object.keys(targets).join(", ")}.`);
const { dir, counted, featureTerms, budget, longHunkExceptions } = target;
const base = valueOf("--base") ?? target.base;
const json = args.includes("--json");
const check = args.includes("--check");

function valueOf(flag) {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

function git(...gitArgs) {
    return execFileSync("git", gitArgs, { cwd: rootDir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const files = [];
for (const line of git("diff", "--numstat", "--no-renames", base, "--", dir).split("\n")) {
    const [added, removed, file] = line.split("\t");
    if (!file || !counted(file) || added === "-") continue;
    files.push({ file, added: Number(added), removed: Number(removed) });
}
const addedFiles = new Set(
    git("diff", "--name-only", "--no-renames", "--diff-filter=A", base, "--", dir).split("\n").filter(Boolean),
);

const unmarkedHunks = [];
const longHunks = [];
const termCounts = Object.fromEntries(featureTerms.map(term => [term, 0]));
let current;
let hunk;
const finishHunk = () => {
    if (hunk && !addedFiles.has(current) && !hunk.marked) unmarkedHunks.push({ file: current, line: hunk.line, added: hunk.added, removed: hunk.removed });
    if (hunk && !addedFiles.has(current) && hunk.added > maxHunkAdded) {
        const exception = longHunkExceptions.find(({ file, contains }) => file === current && hunk.text.includes(contains));
        if (!exception || hunk.added > exception.maxAdded) longHunks.push({ file: current, line: hunk.line, added: hunk.added });
    }
    hunk = undefined;
};
for (const line of git("diff", "--unified=0", "--no-renames", "--ignore-cr-at-eol", base, "--", dir).split("\n")) {
    if (line.startsWith("diff --git ")) {
        finishHunk();
        current = undefined;
    }
    else if (line.startsWith("+++ ")) {
        const file = line.slice(4).replace(/^b\//, "");
        current = file !== "/dev/null" && counted(file) ? file : undefined;
    }
    else if (!current) continue;
    else if (line.startsWith("@@")) {
        finishHunk();
        hunk = { line: Number(/\+(\d+)/.exec(line)[1]), added: 0, removed: 0, marked: false, text: "" };
    }
    else if (hunk && line.startsWith("+")) {
        hunk.added++;
        hunk.text += line;
        if (slotMarker.test(line)) hunk.marked = true;
        const lower = line.toLowerCase();
        for (const term of featureTerms) termCounts[term] += lower.split(term.toLowerCase()).length - 1;
    }
    else if (hunk && line.startsWith("-")) hunk.removed++;
}
finishHunk();

const upstream = files.filter(entry => !addedFiles.has(entry.file)).sort((a, b) => b.added + b.removed - (a.added + a.removed));
const added = files.filter(entry => addedFiles.has(entry.file)).sort((a, b) => b.added - a.added);
const sum = (entries, key) => entries.reduce((total, entry) => total + entry[key], 0);
const summary = {
    base,
    upstreamFiles: upstream.length,
    upstreamAdded: sum(upstream, "added"),
    upstreamRemoved: sum(upstream, "removed"),
    newFiles: added.length,
    newFileLines: sum(added, "added"),
    unmarkedHunks: unmarkedHunks.length,
    longHunks: longHunks.length,
};
const overBudget = Object.entries(budget).filter(([key, limit]) => summary[key] > limit).map(([key, limit]) => `${key} ${summary[key]} > ${limit}`);

if (json) {
    console.log(JSON.stringify({ summary, budget, overBudget, upstream, added, unmarkedHunks, longHunks, featureTerms: termCounts }, undefined, 2));
}
else {
    console.log(`${target.name} drift from ${base} (${dir}, ${target.excluded})\n`);
    console.log("Upstream files changed:");
    for (const entry of upstream) console.log(`  +${entry.added}\t-${entry.removed}\t${entry.file}`);
    console.log("\nNew files outside tspp/ directories:");
    for (const entry of added) console.log(`  +${entry.added}\t${entry.file}`);
    console.log("\nFeature terms in added lines:");
    for (const [term, count] of Object.entries(termCounts)) if (count) console.log(`  ${count}\t${term}`);
    console.log(`\nUnmarked hunks in upstream files: ${unmarkedHunks.length}`);
    for (const entry of unmarkedHunks) console.log(`  ${entry.file}:${entry.line} (+${entry.added} -${entry.removed})`);
    console.log(`Hunks too long to be call sites: ${longHunks.length}`);
    for (const entry of longHunks) console.log(`  ${entry.file}:${entry.line} (+${entry.added})`);
    console.log(
        `Total: ${summary.upstreamFiles} upstream files +${summary.upstreamAdded} -${summary.upstreamRemoved}, `
            + `${summary.newFiles} new files +${summary.newFileLines}`,
    );
    console.log(`Budget: ${budget.upstreamFiles} upstream files +${budget.upstreamAdded} -${budget.upstreamRemoved}${overBudget.length ? ` (exceeded: ${overBudget.join(", ")})` : ""}`);
}

if (check) {
    const failures = [
        ...unmarkedHunks.length ? [`${unmarkedHunks.length} hunks in upstream files lack a TSPP-SLOT(<slot>) marker`] : [],
        ...longHunks.length ? [`${longHunks.length} hunks in upstream files are longer than ${maxHunkAdded} lines`] : [],
        ...added.length ? [`${added.length} new files outside the tspp/ directories`] : [],
        ...overBudget.map(entry => `over budget: ${entry}`),
    ];
    for (const failure of failures) console.error(`core-diff --target ${targetName}: ${failure}`);
    if (failures.length) process.exitCode = 1;
}
