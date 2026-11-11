import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as lsp from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { createServer, PACKAGE_ROOT, type TestLspServer } from './test-utils.js';

const repoRoot = path.resolve(PACKAGE_ROOT, '..', '..');
const tsserverPath = path.join(repoRoot, 'packages', 'compiler', 'built', 'local', 'tsserver.js');
// Projects name the plugin through the compiler package that ships it.
const pluginName = 'ts-plus-plus/plugins/operator-sections';
// With the plugin this is a function of the placeholder; without it `_` is a name nothing declares.
const source = 'export const sum = (_ + 1);\n';
const missingName = 'Cannot find name \'_\'.';

/** Real tsservers behind one language server, over a temporary workspace of projects that differ in their plugins. */
describe('TS++ plugins in a multi-project workspace', () => {
    let workspace: string;
    let server: TestLspServer | undefined;
    const diagnostics = new Map<string, lsp.PublishDiagnosticsParams>();
    const versions = new Map<string, number>();

    function writeProject(name: string, plugins: readonly string[], extra: object = {}): void {
        fs.outputJsonSync(path.join(workspace, name, 'tsconfig.json'), {
            compilerOptions: {
                target: 'es2022',
                module: 'commonjs',
                strict: true,
                types: [],
                noEmit: true,
                composite: true,
                plugins: plugins.map(plugin => ({ name: plugin, tspp: true })),
            },
            include: ['src/**/*.tspp'],
            ...extra,
        });
        fs.outputFileSync(path.join(workspace, name, 'src', 'index.tspp'), source);
    }

    function document(name: string): lsp.TextDocumentItem {
        const filePath = path.join(workspace, name, 'src', 'index.tspp');
        return { uri: URI.file(filePath).toString(), languageId: 'tspp', version: 1, text: fs.readFileSync(filePath, 'utf8') };
    }

    async function start(): Promise<TestLspServer> {
        server = await createServer({
            rootUri: URI.file(workspace).toString(),
            publishDiagnostics: params => diagnostics.set(params.uri, params),
            initializationOptionsOverrides: { tsserver: { path: tsserverPath, useSyntaxServer: 'never' } },
        });
        return server;
    }

    async function open(name: string): Promise<lsp.TextDocumentItem> {
        const item = document(name);
        server!.didOpenTextDocument({ textDocument: item });
        await server!.waitForDiagnosticsForFile(item.uri);
        return item;
    }

    function messages(item: lsp.TextDocumentItem): string[] {
        return (diagnostics.get(item.uri)?.diagnostics ?? []).map(diagnostic => diagnostic.message as string);
    }

    async function typeOfSum(item: lsp.TextDocumentItem): Promise<string> {
        const hover = await server!.hover({ textDocument: { uri: item.uri }, position: lsp.Position.create(0, 13) });
        return JSON.stringify(hover?.contents);
    }

    async function expectSection(item: lsp.TextDocumentItem): Promise<void> {
        expect(messages(item)).not.toContain(missingName);
        expect(await typeOfSum(item)).toContain('=>');
    }

    async function expectPlainName(item: lsp.TextDocumentItem): Promise<void> {
        expect(messages(item)).toContain(missingName);
        expect(await typeOfSum(item)).not.toContain('=>');
    }

    /** Makes the server parse the file again, with whatever plugins its process has by now. */
    async function edit(item: lsp.TextDocumentItem): Promise<void> {
        versions.set(item.uri, (versions.get(item.uri) ?? 1) + 1);
        diagnostics.delete(item.uri);
        server!.didChangeTextDocument({
            textDocument: { uri: item.uri, version: versions.get(item.uri)! },
            contentChanges: [{ text: `${source}${'\n'.repeat(versions.get(item.uri)!)}` }],
        });
        await server!.waitForDiagnosticsForFile(item.uri);
    }

    async function waitForMessages(item: lsp.TextDocumentItem, condition: (messages: string[]) => boolean): Promise<void> {
        for (const deadline = Date.now() + 30_000; !condition(messages(item));) {
            expect(Date.now(), `diagnostics of ${item.uri}: ${JSON.stringify(messages(item))}`).toBeLessThan(deadline);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    beforeEach(() => {
        diagnostics.clear();
        versions.clear();
        workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tspp-isolation-')));
        // Directory junctions work on Windows without symlink privileges.
        fs.ensureSymlinkSync(path.join(repoRoot, 'packages', 'compiler'), path.join(workspace, 'node_modules', 'ts-plus-plus'), 'junction');
    });

    afterEach(() => {
        server?.closeAllForTesting();
        server?.shutdown();
        server = undefined;
        fs.removeSync(workspace);
    });

    it.each([
        { first: 'with-plugin', second: 'without-plugin' },
        { first: 'without-plugin', second: 'with-plugin' },
    ])('gives each project its own plugins when $first opens first', async ({ first, second }) => {
        writeProject('with-plugin', [pluginName]);
        writeProject('without-plugin', []);
        await start();
        await open(first);
        await open(second);
        const withPlugin = document('with-plugin');
        const withoutPlugin = document('without-plugin');
        await expectSection(withPlugin);
        await expectPlainName(withoutPlugin);

        // Asking again after the other project answered, and after an edit that reparses, changes nothing.
        await edit(withoutPlugin);
        await expectPlainName(withoutPlugin);
        await expectSection(withPlugin);
    }, 120_000);

    it('keeps out the plugins of projects a server loads to answer a request', async () => {
        // Finding references from `without-plugin` loads `top`, which refers to it and declares the plugin itself.
        writeProject('without-plugin', []);
        writeProject('top', [pluginName], { references: [{ path: '../without-plugin' }] });
        fs.outputJsonSync(path.join(workspace, 'tsconfig.json'), { files: [], references: [{ path: './without-plugin' }, { path: './top' }] });
        await start();
        const item = await open('without-plugin');
        await server!.references({
            textDocument: { uri: item.uri },
            position: lsp.Position.create(0, 13),
            context: { includeDeclaration: true },
        });
        await edit(item);
        await expectPlainName(item);
    }, 120_000);

    it('moves an open file to the right server when its tsconfig changes its plugins', async () => {
        writeProject('without-plugin', []);
        writeProject('other', []);
        await start();
        const changing = await open('without-plugin');
        const unchanged = await open('other');
        await expectPlainName(changing);

        writeProject('without-plugin', [pluginName]);
        await waitForMessages(changing, current => !current.includes(missingName));
        await expectSection(changing);
        // The server `unchanged` shares with the file's old set saw the new config too; it must have refused the plugin.
        await edit(unchanged);
        await expectPlainName(unchanged);

        writeProject('without-plugin', []);
        await waitForMessages(changing, current => current.includes(missingName));
        await expectPlainName(changing);
    }, 120_000);
});
