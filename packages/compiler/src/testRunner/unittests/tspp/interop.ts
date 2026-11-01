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
});
