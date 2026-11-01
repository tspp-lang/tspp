import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const examplesRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const exampleNames = readdirSync(examplesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{2}-/.test(entry.name))
    .map(entry => entry.name)
    .sort();
const richDeclarationExamples = new Set([
    "02-formal-verification",
    "03-nominal-types",
    "05-dependent-types",
    "06-type-computation",
    "07-higher-kinded-types",
    "08-static-interface-members",
    "10-macros",
]);

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
            "--allowUnreachableCode",
            "false",
            "--declaration",
            richDeclarationExamples.has(example.directory) ? "true" : "false",
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
        if (richDeclarationExamples.has(example.directory)) verifyFeatureRichDeclarations(example.directory, runtimeDirectory);
        console.log(`[examples] running ${example.directory}/${relative(runtimeDirectory, emittedEntry)}`);
        run(process.execPath, [emittedEntry], example.root);
    }
    finally {
        rmSync(runtimeDirectory, { recursive: true, force: true });
    }
}

function verifyFeatureRichDeclarations(example, outputDirectory) {
    if (example === "02-formal-verification") return verifyFormalVerificationDeclarations(outputDirectory);
    if (example === "03-nominal-types") return verifyNominalTypeDeclarations(outputDirectory);
    if (example === "05-dependent-types") return verifyDependentTypeDeclarations(outputDirectory);
    if (example === "06-type-computation") return verifyTypeComputationDeclarations(outputDirectory);
    if (example === "07-higher-kinded-types") return verifyHigherKindedDeclarations(outputDirectory);
    if (example === "08-static-interface-members") return verifyStaticInterfaceDeclarations(outputDirectory);
    if (example === "10-macros") return verifyMacroDeclarations(outputDirectory);
    throw new Error(`Missing rich declaration verifier for ${example}.`);
}

function verifyNominalTypeDeclarations(outputDirectory) {
    const rich = readFileSync(join(outputDirectory, "01-basics.d.tspp"), "utf8");
    for (const expected of [
        "export newtype UserId = string;",
        "export data Option<T> = None | Some(value: T);",
        "export data Status = Idle | Loading | Ready;",
    ]) {
        if (!rich.includes(expected)) throw new Error(`Feature-rich declaration lost nominal syntax: ${expected}`);
    }
}

function verifyFormalVerificationDeclarations(outputDirectory) {
    const contracts = readFileSync(join(outputDirectory, "02-function-contracts.d.tspp"), "utf8");
    const refinements = readFileSync(join(outputDirectory, "04-refinement-types.d.tspp"), "utf8");
    const compatibilityContracts = readFileSync(join(outputDirectory, "02-function-contracts.d.ts"), "utf8");
    const compatibilityRefinements = readFileSync(join(outputDirectory, "04-refinement-types.d.ts"), "utf8");
    for (const expected of [
        "declare function absolute(value: bigint) with {",
        "ensures: result >= 0n;",
        "declare function successor(value: bigint) with {",
        "requires: value >= 0n;",
    ]) {
        if (!contracts.includes(expected)) throw new Error(`Feature-rich declaration lost verification contract syntax: ${expected}`);
    }
    for (const expected of [
        "type Positive = bigint with {",
        "predicate: value > 0n;",
        "type NonNegative = bigint with {",
    ]) {
        if (!refinements.includes(expected)) throw new Error(`Feature-rich declaration lost refinement syntax: ${expected}`);
    }
    if (compatibilityContracts.includes(" with {") || compatibilityRefinements.includes(" with {")) {
        throw new Error("Formal-verification compatibility declarations leaked TS++ contract syntax.");
    }
}

function verifyDependentTypeDeclarations(outputDirectory) {
    const basics = readFileSync(join(outputDirectory, "01-basics.d.tspp"), "utf8");
    const matching = readFileSync(join(outputDirectory, "03-type-matching.d.tspp"), "utf8");
    const compatibility = readFileSync(join(outputDirectory, "01-basics.d.ts"), "utf8");
    for (const expected of [
        "export type UniverseZero: Type1 = Type0;",
        "export type PolymorphicIdentity: Type1 = {A: Type0} -> (value: A) -> A;",
    ]) {
        if (!basics.includes(expected)) throw new Error(`Feature-rich declaration lost dependent syntax: ${expected}`);
    }
    for (const expected of [
        "export type NumberResult: Type0 = match mltt number",
        "export type ElementOrSelf: Type1 = (A: Type0) -> match mltt A",
    ]) {
        if (!matching.includes(expected)) throw new Error(`Feature-rich declaration lost dependent syntax: ${expected}`);
    }
    if (!compatibility.includes("export type UniverseZero = any;")) {
        throw new Error("Compatibility declaration no longer contains the TypeScript projection.");
    }
}

function verifyTypeComputationDeclarations(outputDirectory) {
    const bindings = readFileSync(join(outputDirectory, "01-let-bindings.d.tspp"), "utf8");
    const matching = readFileSync(join(outputDirectory, "02-type-match.d.tspp"), "utf8");
    const lambdas = readFileSync(join(outputDirectory, "03-type-lambdas.d.tspp"), "utf8");
    const combined = readFileSync(join(outputDirectory, "04-combined-computation.d.tspp"), "utf8");
    const compatibility = readFileSync(join(outputDirectory, "01-let-bindings.d.ts"), "utf8");
    for (const [output, expected] of [
        [bindings, "export type Response<T> = let Payload ="],
        [matching, "export type Classify<T> = match T {"],
        [lambdas, "export type Identity = <T> =>> T;"],
        [combined, "export type Transform<Container, Mapper: Type0 => Type0> = match Container {"],
    ]) {
        if (!output.includes(expected)) throw new Error(`Feature-rich declaration lost type-computation syntax: ${expected}`);
    }
    if (!compatibility.includes("extends [infer Payload]")) {
        throw new Error("Type-computation compatibility declaration no longer contains its TypeScript projection.");
    }
}

function verifyHigherKindedDeclarations(outputDirectory) {
    const rich = readFileSync(join(outputDirectory, "01-basics.d.tspp"), "utf8");
    const compatibility = readFileSync(join(outputDirectory, "01-basics.d.ts"), "utf8");
    for (const expected of [
        "export type UniverseZero: Type1 = Type0;",
        "export type Arrays: Type0 => Type0 = Array;",
        "type Box = <Value> =>> { value: Value };",
    ]) {
        if (!rich.includes(expected)) throw new Error(`Feature-rich declaration lost higher-kinded syntax: ${expected}`);
    }
    if (!compatibility.includes("export type UniverseZero = unknown;")) {
        throw new Error("Higher-kinded compatibility declaration no longer contains its TypeScript projection.");
    }
}

function verifyStaticInterfaceDeclarations(outputDirectory) {
    const rich = readFileSync(join(outputDirectory, "01-basics.d.tspp"), "utf8");
    for (const expected of [
        "static readonly mediaType: string;",
        "static deserialize(data: string): this;",
        "static fromVersion(version: number): this;",
    ]) {
        if (!rich.includes(expected)) throw new Error(`Feature-rich declaration lost static interface syntax: ${expected}`);
    }
}

function verifyMacroDeclarations(outputDirectory) {
    const check = readFileSync(join(outputDirectory, "01-check.d.tspp"), "utf8");
    const security = readFileSync(join(outputDirectory, "05-security.d.tspp"), "utf8");
    for (const [output, expected] of [
        [check, "export declare macro function requireFunction"],
        [security, "export declare macro function exposePackageName"],
        [security, "with { timeout: { type: \"fixed\", value: 2, unit: \"s\" }; }"],
    ]) {
        if (!output.includes(expected)) throw new Error(`Feature-rich declaration lost macro syntax: ${expected}`);
    }
}

console.log(`\n[examples] ${packages.length} example packages compiled and ran successfully.`);
