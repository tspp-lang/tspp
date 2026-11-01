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

function positionAt(text: string, offset: number): lsp.Position {
    const before = text.slice(0, offset).split(/\r?\n/);
    return lsp.Position.create(before.length - 1, before.at(-1)?.length ?? 0);
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

    it('keeps operator-section placeholder hover contextual instead of any', async () => {
        const example = exampleSources.find(source => source.name.endsWith(path.join('11-operator-sections', 'src', '01-basics.tspp')))!;
        const server = await createServer({
            rootUri: URI.file(example.root).toString(),
            publishDiagnostics: () => undefined,
            initializationOptionsOverrides: {
                tsserver: {
                    path: path.join(repoRoot, 'packages', 'compiler', 'built', 'local', 'tsserver.js'),
                    useSyntaxServer: 'never',
                },
            },
        });
        try {
            const document = toDocument(example.filePath);
            server.didOpenTextDocument({ textDocument: document });
            const placeholder = document.text.indexOf('_');
            expect(placeholder).toBeGreaterThanOrEqual(0);
            const hover = await server.hover({
                textDocument: { uri: document.uri },
                position: positionAt(document.text, placeholder),
            });
            const rendered = JSON.stringify(hover?.contents);
            expect(rendered).toContain('number');
            expect(rendered).not.toMatch(/\bany\b/);
        }
        finally {
            server.didCloseTextDocument({ textDocument: { uri: URI.file(example.filePath).toString() } });
            server.closeAllForTesting();
            server.shutdown();
        }
    }, 60_000);

    it('keeps feature-owned hover text at the TS++ source level', async () => {
        const cases = [
            {
                packageName: '01-modern-syntax',
                fileName: 'src/01-basics.tspp',
                targets: [
                    { search: 'use left', offset: 4, includes: ['left', 'number'] },
                    { search: 'withValue(20)', fromEnd: true, includes: ['withValue', 'number'] },
                ],
            },
            {
                packageName: '06-type-computation',
                fileName: 'src/01-let-bindings.tspp',
                targets: [
                    { search: 'let Raw', offset: 4, includes: ['Raw', 'raw: T'] },
                    { search: 'wrapped: Raw', includes: ['wrapped', 'Raw'] },
                ],
            },
            {
                packageName: '06-type-computation',
                fileName: 'src/02-type-match.tspp',
                targets: [
                    { search: 'match T', includes: ['keyword', 'match'] },
                    { search: 'match T', offset: 6, includes: ['T', 'Classify'] },
                    { search: 'infer Head', offset: 6, includes: ['Head'] },
                    { search: 'infer Tail', offset: 6, includes: ['Tail'] },
                ],
            },
            {
                packageName: '06-type-computation',
                fileName: 'src/03-type-lambdas.tspp',
                targets: [{ search: 'Identity =', includes: ['Identity', '<T', '=>>'] }],
            },
            {
                packageName: '03-nominal-types',
                fileName: 'src/01-basics.tspp',
                targets: [{ search: 'newtype Box<T>', offset: 12, includes: ['type parameter', 'T'] }],
            },
            {
                packageName: '03-nominal-types',
                fileName: 'src/02-composed-patterns.tspp',
                targets: [
                    { search: 'Either<', includes: ['data Either', 'Left', 'Right'] },
                    { search: 'Either<Left', offset: 7, includes: ['type parameter', 'Left'] },
                    { search: 'Left, Right', offset: 6, includes: ['type parameter', 'Right'] },
                    { search: 'Left(value', includes: ['data constructor', 'Left', 'Either'] },
                    { search: 'Left(1)', includes: ['Left', 'number', 'Either<number, string>'] },
                ],
            },
            {
                packageName: '07-higher-kinded-types',
                fileName: 'src/01-basics.tspp',
                targets: [
                    { search: ': Type0', offset: 2, includes: ['Type0', 'Type1'] },
                    { search: 'Kind: Type1', includes: ['Kind', 'IdentityAtOne', 'Type1'] },
                ],
            },
        ] as const;

        const servers = new Map<string, TestLspServer>();
        try {
            for (const testCase of cases) {
                const root = path.join(examplesRoot, testCase.packageName);
                let server = servers.get(root);
                if (!server) {
                    server = await createServer({
                        rootUri: URI.file(root).toString(),
                        publishDiagnostics: () => undefined,
                        initializationOptionsOverrides: {
                            tsserver: {
                                path: path.join(repoRoot, 'packages', 'compiler', 'built', 'local', 'tsserver.js'),
                                useSyntaxServer: 'never',
                            },
                        },
                    });
                    servers.set(root, server);
                }
                const filePath = path.join(root, ...testCase.fileName.split('/'));
                const document = toDocument(filePath);
                server.didOpenTextDocument({ textDocument: document });
                for (const target of testCase.targets) {
                    const start = 'fromEnd' in target && target.fromEnd
                        ? document.text.lastIndexOf(target.search)
                        : document.text.indexOf(target.search);
                    expect(start, `${testCase.fileName}: ${target.search}`).toBeGreaterThanOrEqual(0);
                    const hover = await server.hover({
                        textDocument: { uri: document.uri },
                        position: positionAt(document.text, start + ('offset' in target ? target.offset : 0)),
                    });
                    const rendered = JSON.stringify(hover?.contents);
                    for (const expected of target.includes) expect(rendered).toContain(expected);
                    expect(rendered).not.toMatch(/\bany\b|\(Missing\)|__@nominal@/);
                }
                server.didCloseTextDocument({ textDocument: { uri: document.uri } });
            }
        }
        finally {
            for (const server of servers.values()) {
                server.closeAllForTesting();
                server.shutdown();
            }
        }
    }, 120_000);

    it('does not leak projection or synthesized-checker any types into feature-owned declarations', async () => {
        const targets = new Map<string, number[]>();
        const addMatches = (filePath: string, expression: RegExp, capture = 1, skipExpectedErrors = false) => {
            const text = fs.readFileSync(filePath, 'utf8');
            const offsets = targets.get(filePath) ?? [];
            for (let match; (match = expression.exec(text));) {
                if (skipExpectedErrors && text.slice(Math.max(0, match.index - 160), match.index).includes('@ts-expect-error')) {
                    continue;
                }
                offsets.push(match.index + match[0].indexOf(match[capture]));
            }
            if (offsets.length) targets.set(filePath, offsets);
        };

        const dependentRoot = path.join(examplesRoot, '05-dependent-types');
        for (const filePath of collectTsppFiles(path.join(dependentRoot, 'src'))) {
            addMatches(filePath, /\btype\s+([A-Za-z_$][\w$]*)\s*:/gu);
        }
        for (const packageName of ['03-nominal-types', '04-newtype-consumer']) {
            const sourceRoot = path.join(examplesRoot, packageName, 'src');
            for (const filePath of collectTsppFiles(sourceRoot)) {
                addMatches(
                    filePath,
                    /\bconst\s+([A-Za-z_$][\w$]*)[^=\r\n]*=\s*match\b/gu,
                    1,
                    /*skipExpectedErrors*/ true,
                );
            }
        }
        const consumerFile = path.join(examplesRoot, '04-newtype-consumer', 'src', '01-consumer.tspp');
        const consumerText = fs.readFileSync(consumerFile, 'utf8');
        targets.get(consumerFile)!.push(consumerText.indexOf('None'));
        const formalFile = path.join(examplesRoot, '02-formal-verification', 'src', '10-logic-library.tspp');
        addMatches(formalFile, /\b([A-Za-z_$][\w$]*)\s*=>/gu);

        const servers = new Map<string, TestLspServer>();
        try {
            for (const [filePath, offsets] of targets) {
                expect(offsets.length, path.relative(examplesRoot, filePath)).toBeGreaterThan(0);
                const packageRoot = examplePackages.find(example => filePath.startsWith(example.root + path.sep))!.root;
                let server = servers.get(packageRoot);
                if (!server) {
                    server = await createServer({
                        rootUri: URI.file(packageRoot).toString(),
                        publishDiagnostics: () => undefined,
                        initializationOptionsOverrides: {
                            tsserver: {
                                path: path.join(repoRoot, 'packages', 'compiler', 'built', 'local', 'tsserver.js'),
                                useSyntaxServer: 'never',
                            },
                        },
                    });
                    servers.set(packageRoot, server);
                }
                const document = toDocument(filePath);
                server.didOpenTextDocument({ textDocument: document });
                for (const offset of offsets) {
                    const hover = await server.hover({
                        textDocument: { uri: document.uri },
                        position: positionAt(document.text, offset),
                    });
                    const location = `${path.relative(examplesRoot, filePath)}:${positionAt(document.text, offset).line + 1}`;
                    expect(hover, `${location} should have feature-owned hover information`).toBeDefined();
                    const rendered = JSON.stringify(hover!.contents);
                    expect(rendered, `${location} should not expose an implementation fallback`).not.toMatch(/\bany\b|\(Missing\)/);
                }
                server.didCloseTextDocument({ textDocument: { uri: document.uri } });
            }
        }
        finally {
            for (const server of servers.values()) {
                server.closeAllForTesting();
                server.shutdown();
            }
        }
    }, 120_000);
});
