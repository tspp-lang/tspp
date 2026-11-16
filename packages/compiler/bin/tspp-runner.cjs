// Compile the complete program before Node evaluates any user code. Runtime hooks only load this compilation's output.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const help = `TS++: run a program, or explicitly compile a project.

Usage:
  tspp <file.tspp> [arguments...]       Run a program with its nearest tsppconfig.json
  tspp --compile [compiler options]    Compile without running (-c is an alias)
  tspp --compile -p .                  Compile the current TS++ project
  tspp --compile --help                Show all compiler options
  tspp --version                       Show the compiler version

All arguments after the entry file are passed to the program unchanged.
Running requires Node.js 22.15 or newer. Compilation keeps its existing Node.js requirements.
`;

function bundle(name) {
    const development = path.resolve(__dirname, "../built/local", name);
    return fs.existsSync(development) ? development : path.resolve(__dirname, "../lib", name);
}

async function main(args) {
    if (args[0] === "--compile" || args[0] === "-c") {
        process.argv.splice(2, process.argv.length - 2, ...args.slice(1));
        require(bundle("tsc.js"));
        return;
    }
    if (!args.length || ["--help", "-h", "-?"].includes(args[0])) {
        process.stdout.write(help);
        return;
    }
    if (["--version", "-v"].includes(args[0]) && args.length === 1) {
        require(bundle("tsc.js"));
        return;
    }
    if (args[0].startsWith("-")) throw new Error(`Compiler options require --compile. Use "tspp --compile ${args.join(" ")}".`);
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major < 22 || major === 22 && minor < 15 || typeof require("node:module").registerHooks !== "function") throw new Error("Running TS++ programs requires Node.js 22.15 or newer with module.registerHooks. Use --compile to compile on older Node.js versions.");
    const entry = path.resolve(args[0]);
    if (!/\.(?:tspp|[cm]?tsx?)$/i.test(entry) || /\.d\.(?:tspp|[cm]?ts)$/i.test(entry)) {
        throw new Error("Expected an executable .tspp, .ts, .tsx, .mts, or .cts entry file. Use --compile for compilation.");
    }
    if (!fs.statSync(entry, { throwIfNoEntry: false })?.isFile()) throw new Error(`Entry file does not exist: ${entry}`);
    const ts = require(bundle("typescript.js"));
    if (!ts.createProgramAsync || !ts.createTSPPConfigHost) throw new Error("The TS++ runner needs a built TS++ compiler. Run pnpm build:compiler in a source checkout.");
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-run-"));
    try {
        const manifest = await compile(ts, entry, directory);
        if (!manifest) return;
        const manifestPath = path.join(directory, "manifest.json");
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        await run(entry, args.slice(1), manifestPath);
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

async function compile(ts, entry, directory) {
    const host = ts.createTSPPConfigHost(ts.sys);
    const configPath = ts.findConfigFile(path.dirname(entry), host.fileExists, "tsppconfig.json");
    const parsed = configPath ? ts.getParsedCommandLineOfConfigFile(
        configPath,
        {},
        Object.assign(Object.create(host), {
            onUnRecoverableConfigFileDiagnostic: diagnostic => {
                throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
            },
        }),
    ) : { fileNames: [], options: {}, errors: [] };
    if (!parsed) throw new Error(`Cannot read ${configPath}`);
    if (report(ts, parsed.errors)) return;
    if (configPath && !ts.loadTSPPConfiguredPlugins(parsed.options, configPath, host)) {
        process.exitCode = 1;
        return;
    }
    const options = {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        ...parsed.options,
        // Execution needs JavaScript and maps, regardless of a project's declaration-only or editor settings.
        noEmit: false,
        noEmitOnError: true,
        emitDeclarationOnly: false,
        declaration: false,
        declarationMap: false,
        composite: false,
        incremental: false,
        tsBuildInfoFile: undefined,
        outFile: undefined,
        outDir: undefined,
        rootDir: undefined,
        sourceMap: false,
        inlineSourceMap: true,
        inlineSources: true,
        sourceRoot: undefined,
        mapRoot: undefined,
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
    };
    const roots = new Set([...parsed.fileNames, entry]);
    const resolutions = {};
    // TypeScript does not add CommonJS require() targets to a TS program. Include literal runtime imports as roots too.
    const pending = [...roots];
    for (const pendingFile of pending) {
        const filename = path.resolve(pendingFile);
        if (/\.d\.(?:tspp|[cm]?ts)$/.test(filename)) continue;
        const text = ts.sys.readFile(filename);
        if (text === undefined) continue;
        const imports = ts.preProcessFile(text, /*readImportFiles*/ true, /*detectJavaScriptImports*/ true).importedFiles;
        const importsForFile = resolutions[filename] = {};
        for (const imported of imports) {
            const resolved = ts.resolveModuleName(imported.fileName, filename, options, host).resolvedModule;
            if (!resolved || /\.d\.(?:tspp|[cm]?ts)$/.test(resolved.resolvedFileName)) continue;
            const target = path.resolve(resolved.resolvedFileName);
            importsForFile[imported.fileName] = target;
            if (!roots.has(target) && /\.(?:tspp|[cm]?tsx?)$/.test(target)) {
                roots.add(target);
                pending.push(target);
            }
        }
    }
    const program = await ts.createProgramAsync({ rootNames: [...roots], options, projectReferences: parsed.projectReferences });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    const analysis = await ts.runTSPPProgramAnalyzers(program);
    if (report(ts, [...diagnostics, ...analysis.map(diagnostic => ts.toTSPPAnalysisDiagnostic(program, diagnostic))])) return;
    const files = {};
    const emitted = program.emit(/*targetSourceFile*/ undefined, (filename, text, _bom, _error, sources) => {
        if (!/\.(?:[cm]?js|jsx)$/.test(filename)) return;
        const source = sources?.find(source => !source.isDeclarationFile);
        if (!source) throw new Error(`Cannot associate emitted JavaScript with its source: ${filename}`);
        const original = path.resolve(source.fileName);
        const output = path.join(directory, `${Object.keys(files).length}.js`);
        // Hooks keep the original filename. Absolute map sources work for CJS, ESM and scripts outside cwd.
        text = text.replace(/(\/\/# sourceMappingURL=data:application\/json;base64,)(\S+)/, (_match, prefix, encoded) => {
            const map = JSON.parse(Buffer.from(encoded, "base64").toString());
            map.sources = [pathToFileURL(original).href];
            map.sourceRoot = "";
            return prefix + Buffer.from(JSON.stringify(map)).toString("base64");
        });
        fs.writeFileSync(output, text);
        const format = formatOf(ts, source, options);
        files[original] = { output, format };
    });
    if (report(ts, emitted.diagnostics) || emitted.emitSkipped) {
        process.exitCode = 1;
        return;
    }
    if (!files[entry]) throw new Error(`The compiler did not emit the entry file: ${entry}`);
    return { files, resolutions };
}

function formatOf(ts, source, options) {
    if (options.module === ts.ModuleKind.CommonJS) return "commonjs";
    if ([ts.ModuleKind.Node16, ts.ModuleKind.NodeNext, ts.ModuleKind.Node18, ts.ModuleKind.Node20].includes(options.module)) {
        return source.impliedNodeFormat === ts.ModuleKind.ESNext ? "module" : "commonjs";
    }
    return "module";
}

function report(ts, diagnostics) {
    if (diagnostics.length) {
        process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
            getCurrentDirectory: ts.sys.getCurrentDirectory,
            getCanonicalFileName: filename => filename,
            getNewLine: () => ts.sys.newLine,
        }));
    }
    const failed = diagnostics.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (failed) process.exitCode = 1;
    return failed;
}

async function run(entry, args, manifest) {
    const child = spawn(process.execPath, ["--enable-source-maps", "--require", path.join(__dirname, "tspp-runtime.cjs"), entry, ...args], {
        stdio: "inherit",
        env: { ...process.env, TSPP_RUN_MANIFEST: manifest },
    });
    const forward = signal => {
        // Windows broadcasts console Ctrl+C to both processes. kill('SIGINT') would
        // terminate the child before its own handler can finish cleanup.
        if (process.platform !== "win32" || signal !== "SIGINT") child.kill(signal);
    };
    const sigint = () => forward("SIGINT");
    const sigterm = () => forward("SIGTERM");
    process.on("SIGINT", sigint);
    process.on("SIGTERM", sigterm);
    try {
        const result = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        // Match Node's conventional status for signals while still allowing the temporary output to be removed.
        process.exitCode = result.code ?? (128 + (os.constants.signals[result.signal] || 1));
    }
    finally {
        process.removeListener("SIGINT", sigint);
        process.removeListener("SIGTERM", sigterm);
    }
}

module.exports = { main };
