import path from 'node:path';
import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';
import * as lsp from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { createServer, PACKAGE_ROOT, type TestLspServer } from './test-utils.js';

const repoRoot = path.resolve(PACKAGE_ROOT, '..', '..');
const examplesRoot = path.join(repoRoot, 'packages', 'examples');

function collectTsppFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...collectTsppFiles(entryPath));
        else if (entry.isFile() && entry.name.endsWith('.tspp')) files.push(entryPath);
    }
    return files.sort();
}

function collectExampleFiles(): string[] {
    return fs.readdirSync(examplesRoot, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(examplesRoot, entry.name, 'src')))
        .flatMap(entry => collectTsppFiles(path.join(examplesRoot, entry.name, 'src')))
        .sort();
}

const examplePackages = fs.readdirSync(examplesRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(examplesRoot, entry.name, 'src')))
    .map(entry => ({
        name: entry.name,
        root: path.join(examplesRoot, entry.name),
        files: collectTsppFiles(path.join(examplesRoot, entry.name, 'src')),
    }));
const exampleSources = examplePackages.flatMap(example => example.files.map(filePath => ({
    name: path.relative(examplesRoot, filePath),
    root: example.root,
    filePath,
})));

function toDocument(filePath: string): lsp.TextDocumentItem {
    return {
        uri: URI.file(filePath).toString(),
        languageId: 'tspp',
        version: 1,
        text: fs.readFileSync(filePath, 'utf8'),
    };
}

function documentRange(document: lsp.TextDocumentItem): lsp.Range {
    const lines = document.text.split(/\r?\n/);
    return lsp.Range.create(0, 0, lines.length - 1, lines.at(-1)?.length ?? 0);
}

describe('TS++ examples editor smoke test', () => {
    const exampleFiles = collectExampleFiles();

    it('discovers TS++ source files across every example package', () => {
        expect(exampleFiles.length).toBeGreaterThan(1);
        const packages = new Set(exampleFiles.map(file => path.relative(examplesRoot, file).split(path.sep)[0]));
        expect([...packages].sort()).toEqual(examplePackages.map(example => example.name).sort());
    });

    it.each(exampleSources)('$name serves clean diagnostics, semantic tokens, and code actions', async example => {
        const diagnostics = new Map<string, lsp.PublishDiagnosticsParams>();
        const server: TestLspServer = await createServer({
            rootUri: URI.file(example.root).toString(),
            publishDiagnostics: params => diagnostics.set(params.uri, params),
            initializationOptionsOverrides: {
                tsserver: {
                    path: path.join(repoRoot, 'packages', 'compiler', 'built', 'local', 'tsserver.js'),
                    useSyntaxServer: 'never',
                },
            },
        });
        try {
            const document = toDocument(example.filePath);
            const label = example.name;
            diagnostics.delete(document.uri);
            server.didOpenTextDocument({ textDocument: document });
            try {
                await server.waitForDiagnosticsForFile(document.uri);
                const errors = (diagnostics.get(document.uri)?.diagnostics ?? [])
                    .filter(diagnostic => diagnostic.severity === lsp.DiagnosticSeverity.Error);
                expect(errors, `${label} should have no editor errors`).toEqual([]);

                const fullTokens = await server.semanticTokensFull({ textDocument: document });
                expect(fullTokens.data.length, `${label} should return semantic tokens`).toBeGreaterThan(0);

                const rangeTokens = await server.semanticTokensRange({
                    textDocument: document,
                    range: documentRange(document),
                });
                expect(rangeTokens.data.length, `${label} should return range semantic tokens`).toBeGreaterThan(0);

                let actions: Awaited<ReturnType<TestLspServer['codeAction']>>;
                try {
                    actions = await server.codeAction({
                        textDocument: document,
                        range: documentRange(document),
                        context: { diagnostics: diagnostics.get(document.uri)?.diagnostics ?? [] },
                    });
                }
                catch (error) {
                    throw new Error(`${label} failed a code-action request`, { cause: error });
                }
                expect(actions, `${label} should answer code-action requests`).toBeDefined();
            }
            finally {
                server.didCloseTextDocument({ textDocument: { uri: document.uri } });
            }
        }
        finally {
            server.closeAllForTesting();
            server.shutdown();
        }
    }, 60_000);
});
