import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
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
    const sourceRoot = join(examplesRoot, directory, "src");
    const sources = listFiles(sourceRoot).filter(file => [".ts", ".tspp"].includes(extname(file)) && !/\.d\.(?:ts|tspp)$/.test(file));
    if (sources.length === 0) {
        throw new Error(`${directory} must contain at least one source file.`);
    }
    return { directory, name: manifest.name, root: join(examplesRoot, directory), sourceRoot, entry: sources[0] };
});

function listFiles(directory) {
    return readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name))
        .flatMap(entry => entry.isDirectory() ? listFiles(join(directory, entry.name)) : [join(directory, entry.name)]);
}

function run(command, args, cwd) {
    const windows = process.platform === "win32";
    const result = spawnSync(windows ? (process.env.ComSpec ?? "cmd.exe") : command, [
        ...(windows ? ["/d", "/s", "/c", command] : []),
        ...args,
    ], { cwd, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? 1}.`);
}

for (const example of packages) {
    console.log(`\n[examples] compiling ${example.directory} (${example.name})`);
    run("pnpm", ["--filter", example.name, "check"], join(examplesRoot, "../.."));

    const runtimeDirectory = mkdtempSync(join(example.root, ".runtime-"));
    try {
        console.log(`[examples] emitting ${example.directory} for its runtime smoke test`);
        run("pnpm", [
            "--filter",
            example.name,
            "exec",
            "tspp",
            "-p",
            "tsconfig.json",
            "--noEmit",
            "false",
            "--outDir",
            runtimeDirectory,
            "--rootDir",
            "src",
            "--declaration",
            "false",
            "--declarationMap",
            "false",
            "--pretty",
            "false",
        ], join(examplesRoot, "../.."));

        const emittedEntry = join(runtimeDirectory, relative(example.sourceRoot, example.entry)).replace(/\.(?:tspp|ts)$/, ".js");
        if (!existsSync(emittedEntry)) throw new Error(`${example.directory} did not emit its entry point: ${emittedEntry}`);
        if (/^\s*(?:import|export)\b/m.test(readFileSync(emittedEntry, "utf8"))) {
            writeFileSync(join(runtimeDirectory, "package.json"), JSON.stringify({ type: "module" }));
        }
        console.log(`[examples] running ${example.directory}/${relative(runtimeDirectory, emittedEntry)}`);
        run(process.execPath, [emittedEntry], example.root);
    }
    finally {
        rmSync(runtimeDirectory, { recursive: true, force: true });
    }
}

console.log(`\n[examples] ${packages.length} example packages compiled and ran successfully.`);
