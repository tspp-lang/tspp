import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const examplesRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const exampleNames = readdirSync(examplesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{2}-/.test(entry.name))
    .map(entry => entry.name)
    .sort();

if (exampleNames.length === 0) {
    throw new Error("No numbered example packages were found.");
}

const packages = exampleNames.map(directory => {
    const manifestPath = join(examplesRoot, directory, "package.json");
    if (!existsSync(manifestPath)) {
        throw new Error(`${directory} is missing package.json.`);
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || manifest.name.length === 0) {
        throw new Error(`${directory} must declare a package name.`);
    }
    if (typeof manifest.scripts?.check !== "string") {
        throw new Error(`${manifest.name} must declare a compile-only check script.`);
    }
    return { directory, name: manifest.name };
});

for (const example of packages) {
    console.log(`\n[examples] compiling ${example.directory} (${example.name})`);
    const windows = process.platform === "win32";
    const result = spawnSync(windows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm", [
        ...(windows ? ["/d", "/s", "/c", "pnpm"] : []),
        "--filter",
        example.name,
        "check",
    ], {
        cwd: join(examplesRoot, "../.."),
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\n[examples] ${packages.length} example packages compiled successfully.`);
