import path from 'node:path';
import fs from 'fs-extra';
import { expect, it } from 'vitest';
import * as lsp from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { createServer, PACKAGE_ROOT } from './test-utils.js';

it.each(['range', 'full'] as const)('reports macro argument errors after repeated %s edits', async editKind => {
    const repoRoot = path.resolve(PACKAGE_ROOT, '..', '..');
    const project = path.join(repoRoot, 'packages', 'example-projects', 'scene-viewer');
    const filePath = path.join(project, 'src', 'shaders', 'materials.tspp');
    const original = fs.readFileSync(filePath, 'utf8');
    const valid = original.replace(/macro shaderModule\((?:Plastic|1)\);/, 'macro shaderModule(Plastic);');
    const invalid = valid.replace('macro shaderModule(Plastic);', 'macro shaderModule(1);');
    expect(invalid).not.toBe(valid);
    const uri = URI.file(filePath).toString();
    const diagnostics = new Map<string, lsp.PublishDiagnosticsParams>();
    const server = await createServer({
        rootUri: URI.file(project).toString(),
        publishDiagnostics: params => diagnostics.set(params.uri, params),
        initializationOptionsOverrides: {
            tsserver: {
                path: path.join(repoRoot, 'packages', 'compiler', 'built', 'local', 'tsserver.js'),
                useSyntaxServer: 'never',
            },
        },
    });
    const errors = () => (diagnostics.get(uri)?.diagnostics ?? [])
        .filter(diagnostic => diagnostic.severity === lsp.DiagnosticSeverity.Error);
    try {
        server.didOpenTextDocument({ textDocument: { uri, languageId: 'tspp', version: 1, text: invalid } });
        await server.waitForDiagnosticsForFile(uri);
        const macroErrors = errors().filter(diagnostic => diagnostic.code === 1434);
        expect(macroErrors.length, JSON.stringify(diagnostics.get(uri))).toBeGreaterThan(0);
        const argumentOffset = invalid.indexOf('macro shaderModule(1);') + 'macro shaderModule('.length;
        const prefixLines = invalid.slice(0, argumentOffset).split(/\r?\n/);
        const line = prefixLines.length - 1;
        const character = prefixLines.at(-1)!.length;
        for (const [index, text] of [valid, invalid, valid, invalid].entries()) {
            server.didChangeTextDocument({
                textDocument: { uri, version: index + 2 },
                contentChanges: editKind === 'full' ? [{ text }] : [{
                    range: lsp.Range.create(line, character, line, character + (text === valid ? 1 : 'Plastic'.length)),
                    text: text === valid ? 'Plastic' : '1',
                }],
            });
            await server.waitForDiagnosticsForFile(uri);
            if (text === valid) {
                expect(errors()).toEqual([]);
            } else {
                expect(errors().filter(diagnostic => diagnostic.code === 1434)).toEqual(macroErrors);
            }
        }
    } finally {
        server.didCloseTextDocument({ textDocument: { uri } });
        server.closeAllForTesting();
        server.shutdown();
    }
}, 120_000);
