// Installs what `pnpm pack:release` assembled into an empty project and uses it the way someone outside this repository
// would: no workspace links and no built/ directory to fall back on. One compilation at a time to keep memory bounded.
// The examples sit below the shared node_modules, the layout of an npm workspace, and name their project with `-p .`.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const release = path.join(root, "release");
const examples = path.join(root, "packages", "examples");
const nodeOptions = { ...process.env, NODE_OPTIONS: "--max-old-space-size=1536" };

function npm(args, cwd) {
    const windows = process.platform === "win32";
    const result = spawnSync(windows ? (process.env.ComSpec ?? "cmd.exe") : "npm", [
        ...(windows ? ["/d", "/s", "/c", "npm"] : []),
        ...args,
    ], { cwd, stdio: "inherit" });
    assert.equal(result.status, 0, `npm ${args.join(" ")} failed`);
}

function checkInstalledManifests(consumer) {
    const modules = path.join(consumer, "node_modules");
    const scope = path.join(modules, "@tspp");
    const installed = [
        path.join(modules, "ts-plus-plus"),
        path.join(modules, "tspp-language-server"),
        ...fs.readdirSync(scope).map(name => path.join(scope, name)),
    ];
    for (const directory of installed) {
        const manifest = fs.readFileSync(path.join(directory, "package.json"), "utf8");
        assert.doesNotMatch(manifest, /"workspace:/, `${directory} still names the workspace`);
    }
    assert.ok(!fs.existsSync(path.join(modules, "ts-plus-plus", "built")), "the compiler must not ship built/");
    assert.ok(fs.existsSync(path.join(modules, ".bin", process.platform === "win32" ? "tspp.cmd" : "tspp")), "the tspp command must be linked");
}

function tspp(consumer, cwd, ...args) {
    return spawnSync(process.execPath, [path.join(consumer, "node_modules", "ts-plus-plus", "bin", "tspp"), ...args], { cwd, env: nodeOptions, encoding: "utf8" });
}

function compileExamples(consumer) {
    const names = fs.readdirSync(examples, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^\d{2}-/.test(entry.name))
        .map(entry => entry.name)
        .sort();
    assert.ok(names.length > 0, "no examples found");
    const directories = names.map(name => {
        const directory = path.join(consumer, "examples", name);
        fs.cpSync(path.join(examples, name), directory, {
            recursive: true,
            filter: source => !["node_modules", "dist"].includes(path.basename(source)),
        });
        // An example may consume another's output as a package.
        const linked = path.join(consumer, "node_modules", ...JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).name.split("/"));
        fs.symlinkSync(directory, linked, "junction");
        return directory;
    });
    for (const directory of directories) {
        const compiled = tspp(consumer, directory, "-p", ".", "--pretty", "false");
        assert.equal(compiled.status, 0, `${path.basename(directory)}\n${compiled.stdout}${compiled.stderr}`);
        console.log(`ok  compiled ${path.basename(directory)}`);
    }
    const emitted = spawnSync(process.execPath, [path.join(consumer, "examples", "05-nominal-types", "dist", "01-basics.js")], { encoding: "utf8" });
    assert.equal(emitted.status, 0, `emitted JavaScript failed\n${emitted.stdout}${emitted.stderr}`);
    console.log("ok  ran emitted JavaScript");
}

function writeProject(consumer) {
    const project = path.join(consumer, "broken");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "a.tspp"), [
        "export function refuted(v: bigint) with { ensures: result >= 5n; }: bigint { return v; }",
        "data Choice = Yes | No;",
        'export const wrong: Choice = "text";',
        "",
    ].join("\n"));
    fs.writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
            target: "es2022",
            module: "nodenext",
            noEmit: true,
            strict: true,
            plugins: [{ name: "@tspp/plugin-formal-verification", tspp: true }, { name: "@tspp/plugin-nominal-types", tspp: true }],
        },
        include: ["src"],
    }));
    return project;
}

// A compiler that ignored its plugins could pass every example that checks nothing, so errors must be reported too.
function checkErrorsAreReported(consumer, project) {
    const compiled = tspp(consumer, project, "-p", ".", "--pretty", "false");
    const output = `${compiled.stdout}${compiled.stderr}`;
    assert.equal(compiled.status, 1, output);
    assert.match(output, /refuted postcondition could not be proved/);
    assert.match(output, /error TS2322/);
    console.log("ok  reported checker and verification errors");
}

// Starts the server the way an editor does and waits for it to report a checker error in a TS++ file.
function checkLanguageServer(server, sdk, project) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [server, "--stdio"], { env: nodeOptions, stdio: ["pipe", "pipe", "inherit"] });
        const send = message => {
            const body = JSON.stringify({ jsonrpc: "2.0", ...message });
            child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
        };
        const finish = error => {
            clearTimeout(timer);
            child.kill();
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => finish(new Error("The language server reported no error within 120 seconds.")), 120_000);
        child.on("error", finish);
        const file = path.join(project, "src", "a.tspp");
        let buffered = Buffer.alloc(0);
        child.stdout.on("data", chunk => {
            buffered = Buffer.concat([buffered, chunk]);
            for (;;) {
                const headerEnd = buffered.indexOf("\r\n\r\n");
                if (headerEnd < 0) return;
                const length = Number(/Content-Length: (\d+)/i.exec(buffered.subarray(0, headerEnd).toString())?.[1]);
                if (buffered.length < headerEnd + 4 + length) return;
                const message = JSON.parse(buffered.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
                buffered = buffered.subarray(headerEnd + 4 + length);
                if (message.id === 1) {
                    send({ method: "initialized", params: {} });
                    send({ method: "textDocument/didOpen", params: { textDocument: { uri: pathToFileURL(file).href, languageId: "tspp", version: 1, text: fs.readFileSync(file, "utf8") } } });
                }
                else if (message.method === "textDocument/publishDiagnostics" && message.params.diagnostics.some(diagnostic => diagnostic.code === 2322)) {
                    finish();
                }
                else if (message.id !== undefined && message.method) {
                    send({ id: message.id, result: null });
                }
            }
        });
        send({
            id: 1,
            method: "initialize",
            params: {
                processId: process.pid,
                rootUri: pathToFileURL(project).href,
                capabilities: { textDocument: { publishDiagnostics: {} } },
                initializationOptions: { disableAutomaticTypingAcquisition: true, tsserver: { path: sdk, useSyntaxServer: "never" } },
            },
        });
    });
}

async function checkExtension(consumer, project) {
    const [vsix] = fs.readdirSync(release).filter(file => file.endsWith(".vsix"));
    assert.ok(vsix, "the extension was not assembled");
    const unpacked = path.join(consumer, "vsix");
    const unzip = spawnSync("unzip", ["-q", path.join(release, vsix), "-d", unpacked], { stdio: "inherit" });
    assert.equal(unzip.status, 0, "unzip failed");
    const directory = path.join(unpacked, "extension");
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    const require = createRequire(path.join(directory, "extension.js"));
    for (const name of Object.keys(manifest.dependencies)) {
        if (name !== "vscode-languageclient" && name !== "tspp-language-server") require.resolve(`${name}/package.json`);
    }
    require.resolve("vscode-languageclient/node");
    require.resolve("@tspp/plugin-sdk/editor");
    for (const grammar of manifest.contributes.grammars) assert.ok(fs.existsSync(path.join(directory, grammar.path)), grammar.path);
    const sdk = path.join(path.dirname(require.resolve("ts-plus-plus/package.json")), "lib");
    await checkLanguageServer(require.resolve("tspp-language-server"), sdk, project);
    console.log("ok  the extension's own language server and compiler report errors");
}

const tarballs = fs.existsSync(release) ? fs.readdirSync(release).filter(file => file.endsWith(".tgz")).map(file => path.join(release, file)) : [];
assert.ok(tarballs.length > 0, "Nothing to test: run pnpm pack:release first.");

const consumer = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tspp-release-")));
try {
    fs.writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, version: "1.0.0" }));
    npm(["install", "--no-audit", "--no-fund", ...tarballs], consumer);
    checkInstalledManifests(consumer);
    console.log("ok  installed every tarball");
    compileExamples(consumer);
    const project = writeProject(consumer);
    checkErrorsAreReported(consumer, project);
    await checkLanguageServer(path.join(consumer, "node_modules", "tspp-language-server", "lib", "cli.mjs"), path.join(consumer, "node_modules", "ts-plus-plus", "lib"), project);
    console.log("ok  the language server reports errors");
    await checkExtension(consumer, project);
}
finally {
    fs.rmSync(consumer, { recursive: true, force: true });
}
