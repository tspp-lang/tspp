import * as documents from "../../_namespaces/documents.js";
import * as fakes from "../../_namespaces/fakes.js";
import * as Harness from "../../_namespaces/Harness.js";
import * as ts from "../../_namespaces/ts.js";
import * as vfs from "../../_namespaces/vfs.js";

describe("unittests:: tspp:: TypeScript interoperability", () => {
    function createProgram(files: Record<string, string>, rootNames: string[], options: ts.CompilerOptions = {}) {
        const fs = vfs.createFromFileSystem(
            Harness.IO,
            /*ignoreCase*/ true,
            { documents: Object.entries(files).map(([fileName, content]) => new documents.TextDocument(fileName, content)), cwd: "/" },
        );
        const compilerOptions: ts.CompilerOptions = {
            noLib: true,
            strict: true,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            ...options,
        };
        const host = new fakes.CompilerHost(fs, compilerOptions);
        return { fs, program: ts.createProgram({ host, rootNames, options: compilerOptions }) };
    }

    function messages(program: ts.Program) {
        return program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    }

    it("allows TS++ source to import TypeScript source and emits two declaration surfaces", () => {
        const { fs, program } = createProgram(
            {
                "/plain.ts": `export const answer: number = 42;`,
                "/consumer.tspp": `import { answer } from "./plain"; export const checked: number = answer;`,
            },
            ["/consumer.tspp"],
            { declaration: true, emitDeclarationOnly: true },
        );
        assert.deepEqual(messages(program), []);
        assert.isFalse(program.emit().emitSkipped);
        assert.isTrue(fs.existsSync("/consumer.d.tspp"));
        assert.isTrue(fs.existsSync("/consumer.d.ts"));
        assert.isTrue(fs.existsSync("/plain.d.ts"));
        assert.isFalse(fs.existsSync("/plain.d.tspp"));
    });

    it("does not allow TypeScript source to import TS++ source", () => {
        const { program } = createProgram(
            {
                "/advanced.tspp": `export const answer: number = 42;`,
                "/consumer.ts": `import { answer } from "./advanced"; export const checked: number = answer;`,
            },
            ["/consumer.ts", "/advanced.tspp"],
        );
        assert.match(messages(program).join("\n"), /Cannot find module '.\/advanced'/u);
    });

    it("selects tsppTypes for TS++ sources and types for TypeScript sources", () => {
        const files = {
            "/node_modules/dual-package/package.json": JSON.stringify({
                name: "dual-package",
                types: "index.d.ts",
                tsppTypes: "index.d.tspp",
            }),
            "/node_modules/dual-package/index.d.ts": `export declare const flavor: "ts";`,
            "/node_modules/dual-package/index.d.tspp": `export declare const flavor: "tspp";`,
            "/plain.ts": `import { flavor } from "dual-package"; export const checked: "ts" = flavor;`,
            "/advanced.tspp": `import { flavor } from "dual-package"; export const checked: "tspp" = flavor;`,
        };
        const { program } = createProgram(files, ["/plain.ts", "/advanced.tspp"]);
        assert.deepEqual(messages(program), []);
    });

    it("supports the tspp-types package exports condition", () => {
        const files = {
            "/node_modules/dual-package/package.json": JSON.stringify({
                name: "dual-package",
                exports: {
                    ".": {
                        "tspp-types": "./index.d.tspp",
                        "types": "./index.d.ts",
                    },
                },
            }),
            "/node_modules/dual-package/index.d.ts": `export declare const flavor: "ts";`,
            "/node_modules/dual-package/index.d.tspp": `export declare const flavor: "tspp";`,
            "/plain.ts": `import { flavor } from "dual-package"; export const checked: "ts" = flavor;`,
            "/advanced.tspp": `import { flavor } from "dual-package"; export const checked: "tspp" = flavor;`,
        };
        const { program } = createProgram(files, ["/plain.ts", "/advanced.tspp"], {
            module: ts.ModuleKind.Node16,
            moduleResolution: ts.ModuleResolutionKind.Node16,
        });
        assert.deepEqual(messages(program), []);
    });

    it("classifies TS++ declarations behind JavaScript paths as typed modules", () => {
        const { program } = createProgram({
            "/library.d.tspp": `export declare const answer: 42;`,
            "/consumer.tspp": `import { answer } from "./library.js"; export const checked: 42 = answer;`,
        }, ["/consumer.tspp"]);
        assert.deepEqual(messages(program), []);
        const consumer = program.getSourceFile("/consumer.tspp")!;
        const specifier = (consumer.statements[0] as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral;
        const resolved = program.getResolvedModuleFromModuleSpecifier(specifier)?.resolvedModule;
        assert.equal(resolved?.resolvedFileName, "/library.d.tspp");
        assert.isTrue(ts.extensionIsTS(resolved!.extension));
    });

    it("resolves compatible declaration barrels before recording module identities", () => {
        const files = {
            "/node_modules/dual-package/package.json": JSON.stringify({
                name: "dual-package",
                version: "1.0.0",
                types: "index.d.ts",
                tsppTypes: "index.d.tspp",
                exports: {
                    ".": {
                        "tspp-types": "./index.d.tspp",
                        "types": "./index.d.ts",
                    },
                },
            }),
            "/node_modules/dual-package/index.d.tspp": `// @tspp-plugins unavailable-feature\nexport * from "./leaf.js";`,
            "/node_modules/dual-package/index.d.ts": `export * from "./leaf.js";`,
            "/node_modules/dual-package/leaf.d.tspp": `// @tspp-plugins unavailable-feature\nexport declare const flavor: "rich";`,
            "/node_modules/dual-package/leaf.d.ts": `export declare const flavor: "compatible";`,
            "/first.tspp": `import { flavor } from "dual-package"; export const checked: "compatible" = flavor;`,
            "/second.tspp": `import { flavor } from "dual-package"; export const checked: "compatible" = flavor;`,
            "/plain.ts": `import { flavor } from "dual-package"; export const checked: "compatible" = flavor;`,
        };
        for (const moduleResolution of [ts.ModuleResolutionKind.Node10, ts.ModuleResolutionKind.Node16]) {
            const { program } = createProgram(files, ["/first.tspp", "/second.tspp", "/plain.ts"], {
                module: moduleResolution === ts.ModuleResolutionKind.Node10 ? ts.ModuleKind.CommonJS : ts.ModuleKind.Node16,
                moduleResolution,
            });
            assert.deepEqual(messages(program), []);
            const first = program.getSourceFile("/first.tspp")!;
            const specifier = (first.statements[0] as ts.ImportDeclaration).moduleSpecifier as ts.StringLiteral;
            const resolved = program.getResolvedModuleFromModuleSpecifier(specifier)?.resolvedModule;
            assert.equal(resolved?.resolvedFileName, "/node_modules/dual-package/index.d.ts");
            assert.equal(resolved?.extension, ts.Extension.Dts);
            assert.equal(resolved?.packageId?.subModuleName, "index.d.ts");
            assert.isUndefined(program.getSourceFile("/node_modules/dual-package/index.d.tspp"));
            assert.isUndefined(program.getSourceFile("/node_modules/dual-package/leaf.d.tspp"));
        }
    });
});
