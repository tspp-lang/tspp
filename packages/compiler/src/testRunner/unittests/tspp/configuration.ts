import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLoggerWithInMemoryLogs } from "../../../harness/tsserverLogger.js";
import * as ts from "../../_namespaces/ts.js";
import { TestServerHost } from "../helpers/virtualFileSystemWithWatch.js";

describe("unittests:: tspp:: configuration", () => {
    const cli = path.resolve("built/local/tsc.js");
    function fixture(action: (root: string, write: (name: string, text: string) => void) => void) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-config-"));
        const write = (name: string, text: string) => {
            const file = path.join(root, name);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, text);
        };
        try { action(root, write); }
        finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
    function run(root: string, args: string[]) {
        return spawnSync(process.execPath, [cli, ...args, "--pretty", "false"], { cwd: root, encoding: "utf8" });
    }
    const config = JSON.stringify({ compilerOptions: { types: [], noEmit: true }, files: ["main.tspp"] });

    it("discovers only tsppconfig and permits explicitly named variants", () => fixture((root, write) => {
        write("main.tspp", "export const value = 1;");
        write("tsconfig.json", '{"compilerOptions":{"unknownSetting":true}}');
        const missing = run(root, ["--showConfig"]);
        assert.notEqual(missing.status, 0);
        assert.match(missing.stdout, /TS5081: Cannot find a tsppconfig\.json/);
        assert.match(run(root, ["-p", "."]).stdout, /TS5057: Cannot find a tsppconfig\.json/);
        write("tsppconfig.json", config);
        assert.match(run(root, ["main.tspp"]).stdout, /TS5112: tsppconfig\.json is present/);
        for (const args of [[], ["-p", "."], ["-p", "tsppconfig.json"]]) {
            const result = run(root, args);
            assert.equal(result.status, 0, result.stdout + result.stderr);
        }
        write("custom.json", config);
        assert.equal(run(root, ["-p", "custom.json"]).status, 0);
        write("legacy.rsp", "-p tsconfig.json");
        assert.match(run(root, ["@legacy.rsp"]).stdout, /TSPP1004/);
        assert.match(run(root, ["--build", "tsconfig.json"]).stdout, /TSPP1004/);
        const ordinary = run(root, ["--ignoreConfig", "main.tspp", "--noEmit", "--outFile", "tsconfig.json"]);
        assert.notMatch(ordinary.stdout, /TSPP1004/);
    }));

    it("initializes the product config without overwriting a TypeScript config", () => fixture((root, write) => {
        write("tsconfig.json", "{}");
        const result = run(root, ["--init"]);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.isTrue(fs.existsSync(path.join(root, "tsppconfig.json")));
        assert.equal(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"), "{}");
        assert.match(result.stdout, /Created a new tsppconfig\.json/);
        assert.match(run(root, ["--init"]).stdout, /TS5054: A 'tsppconfig\.json'/);
    }));

    it("brands generic product diagnostics while preserving ordinary diagnostics and actual shared paths", () => {
        const ordinary = {};
        const product = ts.inheritTSPPConfigHost({});
        const diagnostic = ts.createCompilerDiagnostic(ts.Diagnostics.Cannot_find_a_tsconfig_json_file_at_the_current_directory_Colon_0, "/shared/tsconfig.json");
        assert.strictEqual(ts.getTSPPConfigDiagnostic(diagnostic, ordinary), diagnostic);
        assert.include(ts.flattenDiagnosticMessageText(ts.getTSPPConfigDiagnostic(diagnostic, product).messageText, "\n"), "tsppconfig.json");
        assert.include(ts.flattenDiagnosticMessageText(ts.getTSPPConfigDiagnostic(diagnostic, product).messageText, "\n"), "/shared/tsconfig.json");
        const missing = ts.createCompilerDiagnostic(ts.Diagnostics.Cannot_read_file_0, "/shared/tsconfig.json");
        assert.strictEqual(ts.getTSPPConfigDiagnostic(missing, product), missing);
    });

    it("builds directory references, defaults and custom JSON roots with product config names", () => fixture((root, write) => {
        const library = JSON.stringify({ compilerOptions: { composite: true, types: [], outDir: "out" }, files: ["main.tspp"] });
        write("lib/main.tspp", "export const value = 1;");
        write("lib/tsppconfig.json", library);
        write("lib/tsconfig.json", '{"compilerOptions":{"unknownSetting":true}}');
        const solution = JSON.stringify({ files: [], references: [{ path: "./lib" }] });
        write("tsppconfig.json", solution);
        write("custom.json", solution);
        for (const args of [["--build"], ["--build", "."], ["--build", "custom.json"]]) {
            const result = run(root, args);
            assert.equal(result.status, 0, result.stdout + result.stderr);
        }
        assert.isTrue(fs.existsSync(path.join(root, "lib/out/main.js")));
        write("custom.json", JSON.stringify({ files: [], references: [{ path: "./lib/tsconfig.json" }] }));
        const rejected = run(root, ["--build", "custom.json"]);
        assert.notEqual(rejected.status, 0);
        assert.match(rejected.stdout, /TS\+\+ project references cannot use/);
    }));

    it("isolates configuration parsing and resolves only relative extends directories", () => {
        const host = TestServerHost.createServerHost([
            { path: "/home/src/workspaces/project/main.tspp", content: "export const value = 1;" },
            { path: "/home/src/workspaces/project/base/tsppconfig.json", content: '{"compilerOptions":{"strict":true}}' },
            { path: "/home/src/workspaces/project/base/tsconfig.json", content: '{"compilerOptions":{"strict":false}}' },
            { path: "/home/src/workspaces/project/shared.json", content: '{"compilerOptions":{"noUnusedLocals":true}}' },
        ]);
        const parseHost: ts.ParseConfigHost = host;
        const input = { extends: ["./base", "./shared.json"], files: ["main.tspp"], references: [{ path: "./lib" }] };
        const product = ts.parseJsonConfigFileContent(input, parseHost, "/home/src/workspaces/project", /*existingOptions*/ undefined, "/home/src/workspaces/project/tsppconfig.demo.json");
        assert.equal(product.options.strict, true);
        assert.equal(product.options.noUnusedLocals, true);
        assert.equal(product.projectReferences![0].path, "/home/src/workspaces/project/lib/tsppconfig.json");
        const ordinary = ts.parseJsonConfigFileContent({ files: ["main.tspp"], references: [{ path: "./lib" }] }, parseHost, "/home/src/workspaces/project", /*existingOptions*/ undefined, "/home/src/workspaces/project/tsconfig.json");
        assert.equal(ordinary.projectReferences![0].path, "/home/src/workspaces/project/lib");
        assert.equal(ts.resolveProjectReferencePath(ordinary.projectReferences![0]), "/home/src/workspaces/project/lib/tsconfig.json");
        assert.equal(ts.resolveTSPPConfigFileProjectName("/home/src/workspaces/project/lib"), "/home/src/workspaces/project/lib/tsppconfig.json");
        const custom = ts.parseJsonConfigFileContent(input, ts.createTSPPConfigHost(parseHost), "/home/src/workspaces/project", /*existingOptions*/ undefined, "/home/src/workspaces/project/app.json");
        assert.equal(custom.options.strict, true);
        assert.equal(custom.projectReferences![0].path, "/home/src/workspaces/project/lib/tsppconfig.json");
        assert.include(custom.fileNames, "/home/src/workspaces/project/main.tspp");
        const unmarkedCustom = ts.parseJsonConfigFileContent({ files: ["main.tspp"] }, parseHost, "/home/src/workspaces/project", /*existingOptions*/ undefined, "/home/src/workspaces/project/app.json");
        assert.isTrue(unmarkedCustom.errors.some(diagnostic => diagnostic.code === 6054));
    });

    it("isolates both extends-cache orders and invalidates nested product and TypeScript entries", () => {
        const root = "/home/src/workspaces/project";
        for (const order of [["tsppconfig.json", "tsconfig.json"], ["tsconfig.json", "tsppconfig.json"]]) {
            const host = TestServerHost.createServerHost([
                { path: root + "/main.tspp", content: "export const value = 1;" },
                { path: root + "/base.json", content: '{"extends":"./settings"}' },
                { path: root + "/settings/tsppconfig.json", content: '{"compilerOptions":{"strict":true}}' },
                { path: root + "/shared.json", content: '{"compilerOptions":{"noUnusedLocals":true}}' },
                { path: root + "/nested.json", content: '{"extends":"./shared.json"}' },
            ]);
            const cache = new Map<string, ts.ExtendedConfigCacheEntry>();
            const parse = (name: string, base = "./base.json") => ts.parseJsonConfigFileContent(
                { extends: base, files: ["main.tspp"] }, host, root, /*existingOptions*/ undefined, root + "/" + name,
                /*resolutionStack*/ undefined, /*extraFileExtensions*/ undefined, cache,
            );
            for (const name of order) {
                const parsed = parse(name);
                if (name === "tsppconfig.json") {
                    assert.equal(parsed.options.strict, true);
                    assert.deepEqual(parsed.errors, []);
                }
                else {
                    assert.isUndefined(parsed.options.strict);
                    assert.isAbove(parsed.errors.length, 0);
                }
            }
            host.writeFile(root + "/settings/tsppconfig.json", '{"compilerOptions":{"strict":false}}');
            ts.cleanExtendedConfigCache(cache, host.toPath(root + "/settings/tsppconfig.json"), host.toPath);
            assert.equal(parse("tsppconfig.json").options.strict, false);

            for (const name of order) assert.equal(parse(name, "./nested.json").options.noUnusedLocals, true);
            host.writeFile(root + "/shared.json", '{"compilerOptions":{"noUnusedLocals":false}}');
            ts.cleanExtendedConfigCache(cache, host.toPath(root + "/shared.json"), host.toPath);
            for (const name of order) assert.equal(parse(name, "./nested.json").options.noUnusedLocals, false);
            cache.clear();
            assert.equal(parse("tsppconfig.json").options.strict, false);
        }
    });

    function serviceFor(host: TestServerHost) {
        return new ts.server.ProjectService({
            host,
            logger: createLoggerWithInMemoryLogs(host),
            cancellationToken: ts.server.nullCancellationToken,
            useSingleInferredProject: false,
            useInferredProjectPerProjectRoot: false,
            session: undefined,
        });
    }

    it("selects configs by source language and watches TS++ config creation, edits and deletion", () => {
        const host = TestServerHost.createServerHost([
            { path: "/home/src/workspaces/project/main.tspp", content: "export const value = 1;" },
            { path: "/home/src/workspaces/project/plain.ts", content: "export const value = 1;" },
            { path: "/home/src/workspaces/project/tsconfig.json", content: '{"files":["plain.ts"],"compilerOptions":{"types":[]}}' },
        ]);
        const service = serviceFor(host);
        const project = (file: string) => service.getDefaultProjectForFile(ts.server.toNormalizedPath(file), /*ensureProject*/ true)!;
        service.openClientFile("/home/src/workspaces/project/main.tspp");
        service.openClientFile("/home/src/workspaces/project/plain.ts");
        assert.equal(project("/home/src/workspaces/project/main.tspp").projectKind, ts.server.ProjectKind.Inferred);
        assert.equal(project("/home/src/workspaces/project/plain.ts").getProjectName(), "/home/src/workspaces/project/tsconfig.json");
        host.writeFile("/home/src/workspaces/project/tsppconfig.json", '{"files":["main.tspp"],"compilerOptions":{"types":[],"strict":true}}');
        host.runQueuedTimeoutCallbacks();
        assert.equal(project("/home/src/workspaces/project/main.tspp").getProjectName(), "/home/src/workspaces/project/tsppconfig.json");
        assert.equal(project("/home/src/workspaces/project/plain.ts").getProjectName(), "/home/src/workspaces/project/tsconfig.json");
        host.writeFile("/home/src/workspaces/project/tsppconfig.json", '{"files":["main.tspp"],"compilerOptions":{"types":[],"strict":false}}');
        host.runQueuedTimeoutCallbacks();
        assert.equal(project("/home/src/workspaces/project/main.tspp").getCompilerOptions().strict, false);
        host.deleteFile("/home/src/workspaces/project/tsppconfig.json");
        host.runQueuedTimeoutCallbacks();
        assert.equal(project("/home/src/workspaces/project/main.tspp").projectKind, ts.server.ProjectKind.Inferred);
    });

    it("watches the same product project rather than a neighboring tsconfig", () => {
        const host = TestServerHost.createWatchedSystem([
            { path: "/home/src/workspaces/project/main.tspp", content: "export const value = 1;" },
            { path: "/home/src/workspaces/project/tsppconfig.json", content: '{"files":["main.tspp"],"compilerOptions":{"types":[],"outDir":"out"}}' },
            { path: "/home/src/workspaces/project/tsconfig.json", content: '{"compilerOptions":{"unknownSetting":true}}' },
        ], { currentDirectory: "/home/src/workspaces/project" });
        ts.executeTSPPCommandLine(host, ts.noop, ["--watch", "--preserveWatchOutput"]);
        assert.isTrue(host.fileExists("/home/src/workspaces/project/out/main.js"));
        host.writeFile("/home/src/workspaces/project/other.tspp", "export const other = 2;");
        host.writeFile("/home/src/workspaces/project/tsppconfig.json", '{"files":["other.tspp"],"compilerOptions":{"types":[],"outDir":"out"}}');
        host.runQueuedTimeoutCallbacks();
        assert.isTrue(host.fileExists("/home/src/workspaces/project/out/other.js"));
    });

    it("recognizes an opened product configuration itself instead of searching as ordinary JSON", () => {
        const root = "/home/src/workspaces/project";
        const host = TestServerHost.createServerHost([
            { path: root + "/main.tspp", content: "export const value = 1;" },
            { path: root + "/tsppconfig.json", content: '{"files":["main.tspp"],"compilerOptions":{"types":[]}}' },
            { path: root + "/tsconfig.json", content: '{"files":[]}' },
        ]);
        const service = serviceFor(host);
        service.openClientFile(root + "/tsppconfig.json");
        assert.equal(service.getConfigFileNameForFile(service.getScriptInfo(root + "/tsppconfig.json")!, /*findFromCacheOnly*/ false), root + "/tsppconfig.json");
    });

    it("does not adopt a TypeScript project that already contains the opened TS++ file", () => {
        const host = TestServerHost.createServerHost([
            { path: "/home/src/workspaces/project/main.tspp", content: "export const value = 1;" },
            { path: "/home/src/workspaces/project/plain.ts", content: "export const plain = 1;" },
            { path: "/home/src/workspaces/project/tsconfig.json", content: '{"files":["plain.ts","main.tspp"],"compilerOptions":{"types":[]}}' },
        ]);
        const service = serviceFor(host);
        service.openClientFile("/home/src/workspaces/project/plain.ts");
        service.openClientFile("/home/src/workspaces/project/main.tspp");
        const project = service.getDefaultProjectForFile(ts.server.toNormalizedPath("/home/src/workspaces/project/main.tspp"), /*ensureProject*/ true)!;
        assert.equal(project.projectKind, ts.server.ProjectKind.Inferred);
    });

    it("prefers an ordinary config for TS files while retaining TS++ interop members without one", () => {
        for (const ordinary of [false, true]) {
            const files = [
                { path: "/home/src/workspaces/project/main.tspp", content: 'import { plain } from "./plain.js"; export const value = plain;' },
                { path: "/home/src/workspaces/project/plain.ts", content: "export const plain = 1;" },
                { path: "/home/src/workspaces/project/tsppconfig.json", content: '{"files":["main.tspp"],"compilerOptions":{"types":[]}}' },
            ];
            if (ordinary) files.push({ path: "/home/src/workspaces/project/tsconfig.json", content: '{"files":["plain.ts"],"compilerOptions":{"types":[]}}' });
            const host = TestServerHost.createServerHost(files);
            const service = serviceFor(host);
            service.openClientFile("/home/src/workspaces/project/main.tspp");
            service.openClientFile("/home/src/workspaces/project/plain.ts");
            const project = service.getDefaultProjectForFile(ts.server.toNormalizedPath("/home/src/workspaces/project/plain.ts"), /*ensureProject*/ true)!;
            assert.equal(project.getProjectName(), "/home/src/workspaces/project/" + (ordinary ? "tsconfig.json" : "tsppconfig.json"));
        }
    });

    it("keeps TS++ globals and extension priority out of ordinary configured programs", () => {
        const root = "/home/src/workspaces/project";
        const host = TestServerHost.createServerHost([
            { path: root + "/main.ts", content: "export const used = productOnly;" },
            { path: root + "/main.tspp", content: "export const unrelated = 1;" },
            { path: root + "/globals.tspp", content: "declare const productOnly: number;" },
        ]);
        const parse = (json: object, name = "tsconfig.json", extra?: readonly ts.FileExtensionInfo[]) => ts.parseJsonConfigFileContent(
            { compilerOptions: { types: [], noLib: true }, ...json }, host, root, /*existingOptions*/ undefined, root + "/" + name,
            /*resolutionStack*/ undefined, extra,
        );
        const ordinary = parse({ include: ["**/*"] });
        assert.deepEqual(ordinary.fileNames, [root + "/main.ts"]);
        const program = ts.createProgram(ordinary.fileNames, ordinary.options, ts.createCompilerHostWorker(ordinary.options, /*setParentNodes*/ undefined, host));
        assert.isTrue(program.getSemanticDiagnostics().some(diagnostic => diagnostic.code === 2304));
        const literal = parse({ files: ["globals.tspp"] });
        assert.deepEqual(literal.fileNames, []);
        assert.isTrue(literal.errors.some(diagnostic => diagnostic.code === 6054));
        const extra = [{ extension: ".tspp", isMixedContent: false, scriptKind: ts.ScriptKind.TS }];
        assert.include(parse({ files: ["globals.tspp"] }, "tsconfig.json", extra).fileNames, root + "/globals.tspp");
        const optedIn = ts.parseJsonConfigFileContent({ files: ["globals.tspp"] }, host, root, { allowNonTsExtensions: true }, root + "/tsconfig.json");
        assert.include(optedIn.fileNames, root + "/globals.tspp");
        assert.deepEqual(optedIn.errors, []);
        const product = parse({ files: ["globals.tspp", "main.ts"] }, "tsppconfig.json");
        assert.deepEqual(product.errors, []);
        assert.include(product.fileNames, root + "/globals.tspp");
        const source = ts.parseJsonText(root + "/tsppconfig.demo.json", '{"files":["globals.tspp"]}');
        assert.include(ts.parseJsonSourceFileConfigFileContent(source, host, root).fileNames, root + "/globals.tspp");

        host.writeFile(root + "/main.ts", '/// <reference path="./globals.tspp" />\nexport const used = productOnly;');
        const referenced = parse({ files: ["main.ts"] });
        const create = (options: ts.CompilerOptions) => ts.createProgram(referenced.fileNames, options, ts.createCompilerHostWorker(options, /*setParentNodes*/ undefined, host));
        assert.isUndefined(create(referenced.options).getSourceFile(root + "/globals.tspp"));
        assert.isDefined(create({ ...referenced.options, allowNonTsExtensions: true }).getSourceFile(root + "/globals.tspp"));
        assert.isDefined(ts.createProgram([root + "/globals.tspp"], { noLib: true }, ts.createCompilerHostWorker({ noLib: true }, /*setParentNodes*/ undefined, host)).getSourceFile(root + "/globals.tspp"));
    });

    it("retains arbitrary referenced JSON project origins, feature activation and watch reloads", () => {
        const root = "/home/src/workspaces/project";
        const previousPlugins = ts.getActiveTSPPPlugins();
        try {
            for (const product of [false, true]) {
                ts.setActiveTSPPPlugins([]);
                const child = { compilerOptions: { composite: true, types: [], strict: true, plugins: [{ name: "nominal-types", tspp: true }] }, files: ["main.tspp"] };
                const host = TestServerHost.createServerHost([
                    { path: root + (product ? "/tsppconfig.json" : "/tsconfig.json"), content: JSON.stringify({ files: product ? [] : ["plain.ts"], references: [{ path: "./child/app.json" }] }) },
                    { path: root + "/plain.ts", content: "export const plain = 1;" },
                    { path: root + "/child/app.json", content: JSON.stringify(child) },
                    { path: root + "/child/main.tspp", content: 'export newtype Id = string; export const id: Id = Id("initial");' },
                ]);
                host.require = () => ({ module: require(path.resolve("../plugins/nominal-types/dist")), error: undefined });
                const service = serviceFor(host);
                if (!product) service.openClientFile(root + "/plain.ts");
                service.openClientFile(root + "/child/main.tspp");
                const project = () => service.getDefaultProjectForFile(ts.server.toNormalizedPath(root + "/child/main.tspp"), /*ensureProject*/ true)!;
                if (!product) {
                    assert.equal(project().projectKind, ts.server.ProjectKind.Inferred);
                    assert.deepEqual(ts.getActiveTSPPPlugins(), []);
                    continue;
                }
                assert.equal(project().getProjectName(), root + "/child/app.json");
                assert.include(ts.getActiveTSPPPlugins().map(plugin => plugin.manifest.id), "nominal-types");
                assert.deepEqual(project().getLanguageService().getSyntacticDiagnostics(root + "/child/main.tspp"), []);
                host.writeFile(root + "/child/main.tspp", 'export newtype Id = string; export const id: Id = Id("updated");');
                host.runQueuedTimeoutCallbacks();
                assert.equal(project().getProjectName(), root + "/child/app.json");
                host.writeFile(root + "/child/app.json", JSON.stringify({ ...child, compilerOptions: { ...child.compilerOptions, strict: false } }));
                host.runQueuedTimeoutCallbacks();
                assert.equal(project().getCompilerOptions().strict, false);
                assert.isTrue(ts.isTSPPConfigOptions(project().getCompilerOptions()));
                host.writeFile(root + "/child/other.tspp", 'export newtype Other = number;');
                host.writeFile(root + "/child/app.json", JSON.stringify({ ...child, files: ["other.tspp"] }));
                host.runQueuedTimeoutCallbacks();
                service.openClientFile(root + "/child/other.tspp");
                const other = service.getDefaultProjectForFile(ts.server.toNormalizedPath(root + "/child/other.tspp"), /*ensureProject*/ true)!;
                assert.equal(other.getProjectName(), root + "/child/app.json");
                assert.include(other.getRootFiles(), root + "/child/other.tspp");
            }
        }
        finally {
            ts.setActiveTSPPPlugins(previousPlugins);
        }
    });

    it("upgrades an ordinary cached custom reference without upgrading its ordinary parent", () => {
        const root = "/home/src/workspaces/project";
        const previousPlugins = ts.getActiveTSPPPlugins();
        try {
            ts.setActiveTSPPPlugins([]);
            const host = TestServerHost.createServerHost([
                { path: root + "/tsconfig.json", content: JSON.stringify({ files: ["plain.ts"], references: [{ path: "./child/app.json" }] }) },
                { path: root + "/plain.ts", content: "export const used = productOnly;" },
                { path: root + "/child/app.json", content: JSON.stringify({ compilerOptions: { composite: true, types: [], plugins: [{ name: "nominal-types", tspp: true }] }, files: ["main.tspp"] }) },
                { path: root + "/child/main.tspp", content: 'declare const productOnly: number; newtype Id = string; const id: Id = Id("value");' },
            ]);
            host.require = () => ({ module: require(path.resolve("../plugins/nominal-types/dist")), error: undefined });
            const service = serviceFor(host);
            service.openClientFile(root + "/plain.ts");
            const ordinary = service.getDefaultProjectForFile(ts.server.toNormalizedPath(root + "/plain.ts"), /*ensureProject*/ true)!;
            assert.isFalse(ts.isTSPPConfigOptions(ordinary.getCompilerOptions()));
            host.writeFile(root + "/tsppconfig.json", JSON.stringify({ files: [], references: [{ path: "./child/app.json" }] }));
            host.runQueuedTimeoutCallbacks();
            service.openClientFile(root + "/child/main.tspp");
            const product = service.getDefaultProjectForFile(ts.server.toNormalizedPath(root + "/child/main.tspp"), /*ensureProject*/ true)!;
            assert.equal(product.getProjectName(), root + "/child/app.json");
            assert.include(ts.getActiveTSPPPlugins().map(plugin => plugin.manifest.id), "nominal-types");
            assert.isFalse(ts.isTSPPConfigOptions(ordinary.getCompilerOptions()));
            assert.isFalse(ordinary.getRootFiles().some(file => file.endsWith(".tspp")));
            assert.isFalse(ordinary.getLanguageService().getProgram()!.getSourceFiles().some(file => file.fileName.endsWith(".tspp")));
            assert.isTrue(ordinary.getLanguageService().getSemanticDiagnostics(root + "/plain.ts").some(diagnostic => diagnostic.code === 2304));
            const unmarked = ts.parseJsonConfigFileContent({ files: ["main.tspp"] }, host, root + "/child", /*existingOptions*/ undefined, root + "/child/app.json");
            assert.isTrue(unmarked.errors.some(diagnostic => diagnostic.code === 6054));
        }
        finally {
            ts.setActiveTSPPPlugins(previousPlugins);
        }
    });

    it("does not promote a forbidden legacy config referenced by a product project", () => {
        const root = "/home/src/workspaces/project";
        const previousPlugins = ts.getActiveTSPPPlugins();
        try {
            ts.setActiveTSPPPlugins([]);
            const host = TestServerHost.createServerHost([
                { path: root + "/tsppconfig.json", content: JSON.stringify({ files: [], references: [{ path: "./child/tsconfig.json" }] }) },
                { path: root + "/child/tsconfig.json", content: JSON.stringify({ compilerOptions: { types: [], plugins: [{ name: "nominal-types", tspp: true }] }, files: ["main.tspp"] }) },
                { path: root + "/child/main.tspp", content: "export const value = 1;" },
            ]);
            host.require = () => ({ module: require(path.resolve("../plugins/nominal-types/dist")), error: undefined });
            const service = serviceFor(host);
            service.openClientFile(root + "/child/main.tspp");
            const project = service.getDefaultProjectForFile(ts.server.toNormalizedPath(root + "/child/main.tspp"), /*ensureProject*/ true)!;
            assert.equal(project.projectKind, ts.server.ProjectKind.Inferred);
            assert.deepEqual(ts.getActiveTSPPPlugins(), []);
        }
        finally {
            ts.setActiveTSPPPlugins(previousPlugins);
        }
    });
});
