import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const examplesRoot = join(repoRoot, "packages", "examples");
const exampleNames = readdirSync(examplesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^\d{2}-/.test(entry.name))
    .map(entry => entry.name)
    .sort();
const richDeclarationExamples = new Set([
    "04-static-interface-members",
    "05-nominal-types",
    "08-type-computation",
    "09-higher-kinded-types",
    "10-dependent-types",
    "12-formal-verification",
    "13-macros",
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
    return { directory, name: manifest.name, root: join(examplesRoot, directory), sourceRoot, sources, entry: sources[0] };
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
    run("pnpm", ["--filter", example.name, "check"], repoRoot);

    const runtimeDirectory = mkdtempSync(join(example.root, ".runtime-"));
    try {
        console.log(`[examples] emitting ${example.directory} for its runtime smoke test`);
        emit(example, runtimeDirectory);

        const emittedEntry = join(runtimeDirectory, relative(example.sourceRoot, example.entry)).replace(/\.(?:tspp|ts)$/, ".js");
        if (!existsSync(emittedEntry)) throw new Error(`${example.directory} did not emit its entry point: ${emittedEntry}`);
        // Run every emitted module so feature syntax leaking into any JavaScript output is caught.
        const emittedModules = listFiles(runtimeDirectory).filter(file => extname(file) === ".js");
        if (emittedModules.some(file => /^\s*(?:import|export)\b/m.test(readFileSync(file, "utf8")))) {
            writeFileSync(join(runtimeDirectory, "package.json"), JSON.stringify({ type: "module" }));
        }
        if (richDeclarationExamples.has(example.directory)) verifyFeatureRichDeclarations(example.directory, runtimeDirectory);
        for (const emittedModule of emittedModules) {
            console.log(`[examples] running ${example.directory}/${relative(runtimeDirectory, emittedModule)}`);
            run(process.execPath, [emittedModule], example.root);
        }
        await checkFormattingKeepsJavaScript(example, runtimeDirectory);
    }
    finally {
        rmSync(runtimeDirectory, { recursive: true, force: true });
    }
}

function emit(example, outDir) {
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
        outDir,
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
    ], repoRoot);
}

/**
 * Formats every source of the example as an editor would, through tsserver with the project's plugins, and fails when
 * formatting is not stable or cannot restore indentation: formatting the result again must change nothing, and the
 * source with every line's indentation removed must format to the same text. Then the JavaScript emitted from the
 * formatted sources must equal `emitted` in every byte: formatting may only lay code out. The sources are formatted in
 * place and always restored.
 */
async function checkFormattingKeepsJavaScript(example, emitted) {
    console.log(`[examples] formatting ${example.directory} and emitting it again`);
    const require = createRequire(import.meta.url);
    const { TsServer, locator } = require("../packages/editor-conformance/src/tsserver.cjs");
    const { nonCodeRanges } = require("../packages/plugin-sdk/dist/text.js");
    const formatted = new Map();
    const server = new TsServer();
    try {
        // tsserver formats with the options configured for it, not those of a format request.
        await server.request("configure", { formatOptions: { indentSize: 4, tabSize: 4, convertTabsToSpaces: true, newLineCharacter: "\n" } });
        for (const file of example.sources) {
            const relativeFile = relative(examplesRoot, file);
            const text = readFileSync(file, "utf8");
            let open = text;
            await server.open(file, text, example.root);
            const format = async source => {
                const { at } = locator(open);
                await server.request("updateOpen", { openFiles: [], changedFiles: [{ fileName: file, textChanges: [{ start: { line: 1, offset: 1 }, end: at(open.length), newText: source }] }], closedFiles: [] });
                open = source;
                const { at: end, offsetOf } = locator(source);
                const last = end(source.length);
                const response = await server.request("format", { file, line: 1, offset: 1, endLine: last.line, endOffset: last.offset });
                if (!response.success) throw new Error(`Formatting ${relativeFile} failed: ${String(response.message).split("\n")[0]}`);
                const edits = response.body.map(edit => ({ start: offsetOf(edit.start), end: offsetOf(edit.end), newText: edit.newText })).sort((left, right) => right.start - left.start);
                let result = source;
                for (const edit of edits) result = result.slice(0, edit.start) + edit.newText + result.slice(edit.end);
                return result;
            };
            const result = await format(text);
            const again = await format(result);
            if (again !== result) throw new Error(`Formatting ${relativeFile} again changes it at line ${firstDifferentLine(result, again)}.`);
            const restored = await format(withoutIndentation(text, nonCodeRanges(text)));
            if (restored !== result) throw new Error(`Formatting ${relativeFile} without its indentation gives other text at line ${firstDifferentLine(result, restored)}.`);
            if (result !== text) formatted.set(file, { original: text, result });
            await server.close(file);
        }
    }
    finally {
        server.stop();
    }
    if (!formatted.size) return;
    const formattedDirectory = mkdtempSync(join(example.root, ".formatted-"));
    try {
        for (const [file, { result }] of formatted) writeFileSync(file, result);
        try {
            emit(example, formattedDirectory);
        }
        finally {
            for (const [file, { original }] of formatted) writeFileSync(file, original);
        }
        const javascript = directory => listFiles(directory).filter(file => extname(file) === ".js").map(file => relative(directory, file));
        const before = javascript(emitted);
        const after = javascript(formattedDirectory);
        if (before.join("\n") !== after.join("\n")) throw new Error(`Formatting ${example.directory} changed which JavaScript files it emits.`);
        const changed = before.filter(file => readFileSync(join(emitted, file), "utf8") !== readFileSync(join(formattedDirectory, file), "utf8"));
        if (changed.length) throw new Error(`Formatting ${example.directory} changed its JavaScript: ${changed.join(", ")}`);
    }
    finally {
        rmSync(formattedDirectory, { recursive: true, force: true });
    }
}

function verifyFeatureRichDeclarations(example, outputDirectory) {
    if (example === "04-static-interface-members") return verifyStaticInterfaceDeclarations(outputDirectory);
    if (example === "05-nominal-types") return verifyNominalTypeDeclarations(outputDirectory);
    if (example === "08-type-computation") return verifyTypeComputationDeclarations(outputDirectory);
    if (example === "09-higher-kinded-types") return verifyHigherKindedDeclarations(outputDirectory);
    if (example === "10-dependent-types") return verifyDependentTypeDeclarations(outputDirectory);
    if (example === "12-formal-verification") return verifyFormalVerificationDeclarations(outputDirectory);
    if (example === "13-macros") return verifyMacroDeclarations(outputDirectory);
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
    // Declarations keep the authored text, line breaks included.
    const basics = readFileSync(join(outputDirectory, "01-basics.d.tspp"), "utf8").replace(/\s+/g, " ");
    const matching = readFileSync(join(outputDirectory, "03-type-matching.d.tspp"), "utf8").replace(/\s+/g, " ");
    const compatibility = readFileSync(join(outputDirectory, "01-basics.d.ts"), "utf8");
    for (const expected of [
        "export type UniverseZero: Type1 = Type0;",
        "export type PolymorphicIdentity: Type1 = {A: Type0} -> (value: A) -> A;",
    ]) {
        if (!basics.includes(expected)) throw new Error(`Feature-rich declaration lost dependent syntax: ${expected}`);
    }
    for (const expected of [
        "export type NumberResult: Type0 = match number",
        "export type ElementOrSelf: Type1 = (A: Type0) -> match A",
    ]) {
        if (!matching.includes(expected)) throw new Error(`Feature-rich declaration lost dependent syntax: ${expected}`);
    }
    if (!compatibility.includes("export type UniverseZero = unknown;")) {
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
    if (!compatibility.replace(/\s+/g, " ").includes("extends [ infer Payload ]")) {
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
        [security, "export declare macro({ timeout: { type: \"fixed\", value: 2, unit: \"s\" } }) function exposePackageName"],
    ]) {
        if (!output.includes(expected)) throw new Error(`Feature-rich declaration lost macro syntax: ${expected}`);
    }
}

console.log(`\n[examples] ${packages.length} example packages compiled and ran successfully.`);

/** `text` with the indentation of every line removed, except lines inside a comment or literal. */
function withoutIndentation(text, nonCode) {
    const inside = new Uint8Array(text.length + 1);
    for (const range of nonCode) inside.fill(1, range.start + 1, range.end);
    let result = "";
    for (let index = 0; index < text.length;) {
        const lineEnd = text.indexOf("\n", index) < 0 ? text.length : text.indexOf("\n", index) + 1;
        const line = text.slice(index, lineEnd);
        result += inside[index] ? line : line.replace(/^[ \t]+/, "");
        index = lineEnd;
    }
    return result;
}

function firstDifferentLine(left, right) {
    const leftLines = left.split("\n");
    const rightLines = right.split("\n");
    const index = leftLines.findIndex((line, lineIndex) => line !== rightLines[lineIndex]);
    return (index < 0 ? leftLines.length : index) + 1;
}
