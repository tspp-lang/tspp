// Decides whether the root package.json names a version to release. A version whose vX.Y.Z tag exists is released
// already; one below the highest released version is an error, since a release never goes back; any other version is
// unreleased. The tags are read from origin, so the answer does not depend on what this clone fetched. In GitHub
// Actions, writes `version` and `unreleased` to the step's outputs.
// Usage: node scripts/release-version.mjs
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Orders two versions by SemVer precedence: negative when `a` comes first. */
export function compareVersions(a, b) {
    const [, ...left] = pattern.exec(a);
    const [, ...right] = pattern.exec(b);
    for (let index = 0; index < 3; index++) {
        const difference = Number(left[index]) - Number(right[index]);
        if (difference) return difference;
    }
    // A prerelease comes before the release it leads to.
    if (left[3] === undefined || right[3] === undefined) return (left[3] === undefined ? 1 : 0) - (right[3] === undefined ? 1 : 0);
    const leftParts = left[3].split(".");
    const rightParts = right[3].split(".");
    for (let index = 0; index < Math.min(leftParts.length, rightParts.length); index++) {
        const [x, y] = [leftParts[index], rightParts[index]];
        if (x === y) continue;
        const [xNumeric, yNumeric] = [/^\d+$/.test(x), /^\d+$/.test(y)];
        if (xNumeric && yNumeric) return Number(x) - Number(y);
        if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return leftParts.length - rightParts.length;
}

/** The versions released so far, from origin's vX.Y.Z tags. */
function releasedVersions() {
    const listed = spawnSync("git", ["ls-remote", "--tags", "origin", "refs/tags/v*"], { cwd: root, encoding: "utf8" });
    if (listed.status !== 0) throw new Error(`git ls-remote failed:\n${listed.stderr}`);
    return listed.stdout.split(/\r?\n/)
        .map(line => /refs\/tags\/v([^\s^]+)$/.exec(line)?.[1])
        // v0.0.0 marks the upstream TypeScript commit this fork started from, not a TS++ release.
        .filter(version => version !== undefined && version !== "0.0.0" && pattern.test(version));
}

/** What to do with `version`, given the versions already released. */
export function decide(version, released) {
    if (!pattern.test(version)) return { error: `The root package.json version ${version} is not a SemVer version.` };
    if (released.includes(version)) return { unreleased: false, reason: `v${version} is already released.` };
    const latest = released.reduce((highest, other) => highest === undefined || compareVersions(other, highest) > 0 ? other : highest, undefined);
    if (latest !== undefined && compareVersions(version, latest) < 0) {
        return { error: `The root package.json version ${version} is below v${latest}, which is already released.` };
    }
    return { unreleased: true, reason: `${version} is unreleased${latest === undefined ? "" : `; the latest release is v${latest}`}.` };
}

function main() {
    const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const decision = decide(String(version), releasedVersions());
    if (decision.error) {
        console.error(decision.error);
        process.exit(1);
    }
    console.log(decision.reason);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nunreleased=${decision.unreleased}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
