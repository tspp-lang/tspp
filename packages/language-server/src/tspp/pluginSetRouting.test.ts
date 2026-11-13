import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommandTypes, EventName, type ts } from '../ts-protocol.js';
import { PluginSetRoutingTsServer } from './pluginSetRouting.js';
import { PluginSetResolver, pluginSetKey, pluginsOfKey } from './pluginSets.js';
import type { ITypeScriptServer, TypeScriptServerExitEvent } from '../tsServer/server.js';
import { ServerResponse } from '../typescriptService.js';

const noResponse = { isAsync: false, token: undefined, expectsResult: false };
const withResponse = { isAsync: false, token: undefined, expectsResult: true };

class FakeServer implements ITypeScriptServer {
    public readonly requests: { command: string; args: unknown; }[] = [];
    public killed = false;
    public readonly tsServerLogFile = undefined;
    private eventHandler?: (event: ts.server.protocol.Event) => void;
    private exitHandler?: (event: TypeScriptServerExitEvent) => void;

    onEvent(handler: (event: ts.server.protocol.Event) => void): void {
        this.eventHandler = handler;
    }
    onExit(handler: (event: TypeScriptServerExitEvent) => void): void {
        this.exitHandler = handler;
    }
    onError(): void {}
    onStdErr(): void {}
    kill(): void {
        this.killed = true;
    }
    dispose(): void {}
    executeImpl(command: string, args: unknown, executeInfo: { expectsResult: boolean; }): any[] {
        this.requests.push({ command, args });
        return [executeInfo.expectsResult ? Promise.resolve(ServerResponse.NoContent) : undefined];
    }
    fire(event: string, body: object): void {
        this.eventHandler?.({ seq: 0, type: 'event', event, body });
    }
    exit(): void {
        this.exitHandler?.({ code: 1, signal: null });
    }
    commands(): string[] {
        return this.requests.map(request => request.command);
    }
}

/** A router over fake servers, where the first path segment of a file names its plugin set. */
function createRouter(keys: Map<string, string> = new Map()) {
    const servers = new Map<string, FakeServer>();
    const router = new PluginSetRoutingTsServer({
        spawn: key => {
            const server = new FakeServer();
            servers.set(key, server);
            return server;
        },
        resolve: file => keys.get(file) ?? file.split('/')[1] ?? '',
        invalidate: () => {},
        getDocumentText: file => `text of ${file}`,
        workspaceRoot: undefined,
        idleTimeout: 1000,
    });
    const events: ts.server.protocol.Event[] = [];
    router.onEvent(event => events.push(event));
    const open = (file: string) => {
        void router.executeImpl(CommandTypes.Open, { file, fileContent: '' }, noResponse);
    };
    return { router, servers, events, open };
}

describe('PluginSetRoutingTsServer', () => {
    it('starts one server per plugin set, when a file of that set first opens', () => {
        const { router, servers, open } = createRouter();
        expect(servers.size).toBe(0);
        open('/x/a.tspp');
        open('/x/b.tspp');
        open('/y/c.tspp');
        expect([...servers.keys()]).toEqual(['x', 'y']);
        expect(router.pluginSetKeys).toEqual(['x', 'y']);
    });

    it('sends a request to the server of the file it names', () => {
        const { router, servers, open } = createRouter();
        open('/x/a.tspp');
        open('/y/b.tspp');
        void router.executeImpl(CommandTypes.Quickinfo, { file: '/y/b.tspp', line: 1, offset: 1 }, withResponse);
        void router.executeImpl(CommandTypes.OrganizeImports, { scope: { type: 'file', args: { file: '/x/a.tspp' } } }, withResponse);
        expect(servers.get('y')!.commands()).toContain(CommandTypes.Quickinfo);
        expect(servers.get('x')!.commands()).not.toContain(CommandTypes.Quickinfo);
        expect(servers.get('x')!.commands()).toContain(CommandTypes.OrganizeImports);
    });

    it('splits a diagnostics request between servers and settles when they all have', async () => {
        const { router, servers, open } = createRouter();
        open('/x/a.tspp');
        open('/y/b.tspp');
        open('/y/c.tspp');
        await router.executeImpl(CommandTypes.Geterr, { delay: 0, files: ['/x/a.tspp', '/y/b.tspp', '/y/c.tspp'] }, withResponse)[0];
        expect(servers.get('x')!.requests.at(-1)!.args).toMatchObject({ files: ['/x/a.tspp'] });
        expect(servers.get('y')!.requests.at(-1)!.args).toMatchObject({ files: ['/y/b.tspp', '/y/c.tspp'] });
    });

    it('gives settings to every server, including ones that start later', () => {
        const { router, servers, open } = createRouter();
        open('/x/a.tspp');
        void router.executeImpl(CommandTypes.Configure, { hostInfo: 'host' }, noResponse);
        void router.executeImpl(CommandTypes.Configure, { preferences: { quotePreference: 'single' } }, noResponse);
        void router.executeImpl(CommandTypes.CompilerOptionsForInferredProjects, { options: { strict: true } }, noResponse);
        open('/y/b.tspp');
        expect(servers.get('x')!.commands()).toEqual([CommandTypes.Open, CommandTypes.Configure, CommandTypes.Configure, CommandTypes.CompilerOptionsForInferredProjects]);
        const later = servers.get('y')!;
        expect(later.commands()).toEqual([CommandTypes.Configure, CommandTypes.CompilerOptionsForInferredProjects, CommandTypes.Open]);
        expect(later.requests[0].args).toEqual({ hostInfo: 'host', preferences: { quotePreference: 'single' } });
    });

    it('answers a request that names no file without starting a server when one runs', () => {
        const { router, servers, open } = createRouter();
        open('/x/a.tspp');
        void router.executeImpl(CommandTypes.GetSupportedCodeFixes, null, withResponse);
        expect([...servers.keys()]).toEqual(['x']);
        expect(servers.get('x')!.commands()).toContain(CommandTypes.GetSupportedCodeFixes);
    });

    it('retires a server with no open files, but never the last one', () => {
        vi.useFakeTimers();
        try {
            const { router, servers, open } = createRouter();
            open('/x/a.tspp');
            open('/y/b.tspp');
            void router.executeImpl(CommandTypes.Close, { file: '/x/a.tspp' }, noResponse);
            vi.advanceTimersByTime(500);
            open('/x/a.tspp');
            vi.advanceTimersByTime(5000);
            expect(servers.get('x')!.killed).toBe(false);

            void router.executeImpl(CommandTypes.Close, { file: '/x/a.tspp' }, noResponse);
            void router.executeImpl(CommandTypes.Close, { file: '/y/b.tspp' }, noResponse);
            vi.advanceTimersByTime(5000);
            expect([servers.get('x')!.killed, servers.get('y')!.killed]).toEqual([true, false]);
            expect(router.pluginSetKeys).toEqual(['y']);
        } finally {
            vi.useRealTimers();
        }
    });

    it('moves open files whose plugin set changed, with their current text and settings', () => {
        const keys = new Map<string, string>();
        const { servers, events, open, router } = createRouter(keys);
        open('/x/a.tspp');
        void router.executeImpl(CommandTypes.Configure, { file: '/x/a.tspp', formatOptions: { tabSize: 8 } }, noResponse);
        open('/x/b.tspp');
        keys.set('/x/a.tspp', 'y');
        servers.get('x')!.fire(EventName.projectsUpdatedInBackground, { openFiles: ['/x/b.tspp'] });

        expect(servers.get('x')!.requests.at(-1)).toEqual({ command: CommandTypes.Close, args: { file: '/x/a.tspp' } });
        const moved = servers.get('y')!.requests;
        expect(moved[0].args).toMatchObject({ file: '/x/a.tspp', fileContent: 'text of /x/a.tspp' });
        expect(moved[1].args).toMatchObject({ file: '/x/a.tspp', formatOptions: { tabSize: 8 } });
        expect((events.at(-1) as ts.server.protocol.ProjectsUpdatedInBackgroundEvent).body.openFiles.sort()).toEqual(['/x/a.tspp', '/x/b.tspp']);

        void router.executeImpl(CommandTypes.Quickinfo, { file: '/x/a.tspp', line: 1, offset: 1 }, withResponse);
        expect(servers.get('y')!.commands()).toContain(CommandTypes.Quickinfo);
    });

    it('keeps watcher ids apart across servers and closes the watchers of a retired one', () => {
        vi.useFakeTimers();
        try {
            const { router, servers, events, open } = createRouter();
            open('/x/a.tspp');
            open('/y/b.tspp');
            servers.get('x')!.fire(EventName.createFileWatcher, { id: 1, path: '/x/tsconfig.json' });
            servers.get('y')!.fire(EventName.createFileWatcher, { id: 1, path: '/y/tsconfig.json' });
            const [fromX, fromY] = events.map(event => (event as ts.server.protocol.CreateFileWatcherEvent).body.id);
            expect(fromX).not.toBe(fromY);

            void router.executeImpl(CommandTypes.WatchChange, [{ id: fromY, updated: ['/y/tsconfig.json'] }], noResponse);
            expect(servers.get('y')!.requests.at(-1)).toEqual({ command: CommandTypes.WatchChange, args: [{ id: 1, updated: ['/y/tsconfig.json'] }] });
            expect(servers.get('x')!.commands()).not.toContain(CommandTypes.WatchChange);

            void router.executeImpl(CommandTypes.Close, { file: '/x/a.tspp' }, noResponse);
            vi.advanceTimersByTime(5000);
            expect(events.at(-1)).toMatchObject({ event: EventName.closeFileWatcher, body: { id: fromX } });
        } finally {
            vi.useRealTimers();
        }
    });

    it('stops the other servers when one dies, since the client then restarts everything', () => {
        const { router, servers, open } = createRouter();
        const exits: unknown[] = [];
        router.onExit(event => exits.push(event));
        open('/x/a.tspp');
        open('/y/b.tspp');
        servers.get('x')!.exit();
        expect(servers.get('y')!.killed).toBe(true);
        expect(exits).toHaveLength(1);
        expect(router.pluginSetKeys).toEqual([]);
    });

    it('reroutes open TS++ files immediately after configuration watch changes', () => {
        const keys = new Map([['/x/a.tspp', 'x']]);
        const { router, servers, events, open } = createRouter(keys);
        open('/x/a.tspp');
        servers.get('x')!.fire(EventName.createFileWatcher, { id: 7, path: '/x/tsppconfig.json' });
        const watcherId = (events[0] as ts.server.protocol.CreateFileWatcherEvent).body.id;
        keys.set('/x/a.tspp', 'y');
        void router.executeImpl(CommandTypes.WatchChange, [{ id: watcherId, updated: ['/x/tsppconfig.json'] }], noResponse);
        expect(servers.get('x')!.commands()).toContain(CommandTypes.WatchChange);
        expect(servers.get('x')!.commands()).toContain(CommandTypes.Close);
        expect(servers.get('y')!.requests[0]).toMatchObject({ command: CommandTypes.Open, args: { file: '/x/a.tspp' } });
        expect(events.at(-1)).toMatchObject({ event: EventName.projectsUpdatedInBackground, body: { openFiles: ['/x/a.tspp'] } });
    });
});

describe('TS++ configuration discovery', () => {
    let root: string;
    let resolver: PluginSetResolver;
    const config = (name: string, extra = {}) => ({ compilerOptions: { plugins: [{ name, tspp: true }] }, ...extra });
    function write(file: string, content: object | string): string {
        const filePath = path.join(root, file);
        fs.outputFileSync(filePath, typeof content === 'string' ? content : JSON.stringify(content));
        return filePath;
    }

    beforeAll(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tspp-config-discovery-')));
        resolver = PluginSetResolver.load(path.resolve(import.meta.dirname, '../../../compiler/built/local/tsserver.js'))!;
    });
    afterAll(() => fs.removeSync(root));

    it('uses tsppconfig for TS++ while preserving ordinary TS and JS project discovery', () => {
        write('mixed/tsppconfig.json', config('tspp'));
        write('mixed/tsconfig.json', config('typescript'));
        expect(resolver.resolve(write('mixed/file.tspp', 'export {};'), root)).toBe('tspp');
        expect(resolver.resolve(write('mixed/file.ts', 'export {};'), root)).toBe('typescript');
        write('javascript/jsconfig.json', config('javascript'));
        expect(resolver.resolve(write('javascript/file.js', 'export {};'), root)).toBe('javascript');
    });

    it('never automatically adopts tsconfig or jsconfig for a TS++ source', () => {
        write('legacy/tsconfig.json', config('legacy'));
        write('legacy/jsconfig.json', config('legacy-js'));
        expect(resolver.resolve(write('legacy/file.tspp', 'export {};'), root)).toBe('');
    });

    it('requires an SDK with product configuration APIs instead of parsing TS++ projects as ordinary TS', () => {
        const oldSdk = PluginSetResolver.load(createRequire(import.meta.url).resolve('typescript/lib/tsserver.js'))!;
        write('unsupported-sdk/tsppconfig.json', config('product'));
        const source = write('unsupported-sdk/index.tspp', 'export {};');
        expect(() => oldSdk.resolve(source, root)).toThrow('Rebuild or update the TS++ SDK');
        write('unsupported-sdk/tsconfig.json', config('ordinary'));
        const ordinary = write('unsupported-sdk/index.ts', 'export {};');
        expect(oldSdk.resolve(ordinary, root)).toBe('ordinary');
    });

    it('resolves directory references to tsppconfig instead of a neighboring tsconfig', () => {
        write('solution/tsppconfig.json', { files: [], references: [{ path: './app' }, { path: './tsppconfig.tests.json' }] });
        write('solution/app/tsppconfig.json', config('app', { include: ['src'] }));
        write('solution/app/tsconfig.json', config('wrong'));
        write('solution/tsppconfig.tests.json', config('tests', { include: ['test'] }));
        const app = write('solution/app/src/index.tspp', 'export {};');
        const tests = write('solution/test/index.tspp', 'export {};');
        expect(resolver.resolve(app, root)).toBe('app');
        expect(resolver.resolve(tests, root)).toBe('tests');
    });

    it('routes explicitly opened configuration variants by their own plugin set', () => {
        write('variant/tsppconfig.json', config('main'));
        const alternate = write('variant/tsppconfig.demo.json', config('demo'));
        expect(resolver.resolve(alternate, root)).toBe('demo');
    });

    it('retains TS++ semantics for arbitrary JSON references and their directory extends', () => {
        write('custom-solution/tsppconfig.json', { files: [], references: [{ path: './app.json' }] });
        write('custom-solution/app.json', { extends: './base', include: ['src'] });
        write('custom-solution/base/tsppconfig.json', config('custom-app'));
        write('custom-solution/base/tsconfig.json', config('ordinary-base'));
        // Ordinary TypeScript resolves this relative extends name to base.json.
        write('custom-solution/base.json', config('ordinary-base'));
        const source = write('custom-solution/src/index.tspp', 'export {};');
        expect(resolver.resolve(source, root)).toBe('custom-app');
        write('custom-solution/tsconfig.json', { files: [], references: [{ path: './app.json' }] });
        const ordinarySource = write('custom-solution/src/ordinary.ts', 'export {};');
        expect(resolver.resolve(ordinarySource, root)).toBe('ordinary-base');
    });

    it('rereads inherited configurations after invalidation', () => {
        const base = write('cache/base.json', config('first'));
        write('cache/tsppconfig.json', { extends: './base.json' });
        const source = write('cache/index.tspp', 'export {};');
        expect(resolver.resolve(source, root)).toBe('first');
        write('cache/base.json', config('second'));
        resolver.invalidate();
        expect(resolver.resolve(source, root)).toBe('second');
        fs.removeSync(base);
    });
});

describe('PluginSetResolver', () => {
    const plugin = (name: string, tspp = true) => ({ name, tspp });
    let root: string;
    let resolver: PluginSetResolver;

    function write(file: string, json: object | string): string {
        const filePath = path.join(root, file);
        fs.outputFileSync(filePath, typeof json === 'string' ? json : JSON.stringify(json));
        return filePath;
    }

    function resolve(file: string): readonly string[] {
        resolver.invalidate();
        return pluginsOfKey(resolver.resolve(write(file, 'export {};\n'), root));
    }

    beforeAll(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tspp-plugin-sets-')));
        resolver = PluginSetResolver.load(createRequire(import.meta.url).resolve('typescript/lib/tsserver.js'))!;
        write('direct/tsconfig.json', { compilerOptions: { plugins: [plugin('b'), plugin('a'), plugin('ordinary', false)] } });
        write('base.json', { compilerOptions: { plugins: [plugin('inherited')] } });
        write('extended/tsconfig.json', { extends: '../base.json' });
        write('replaced/tsconfig.json', { extends: '../base.json', compilerOptions: { plugins: [] } });
        // Comments are allowed in configs, and a broken config has no plugins rather than failing the request.
        write('commented/tsconfig.json', '{ /* comment */ "compilerOptions": { "plugins": [{ "name": "c", "tspp": true }] } }');
        write('broken/tsconfig.json', '{ "compilerOptions": ');
        write('solution/tsconfig.json', { files: [], references: [{ path: './tsconfig.app.json' }, { path: './tsconfig.test.json' }] });
        write('solution/tsconfig.app.json', { compilerOptions: { plugins: [plugin('app')] }, include: ['src'] });
        write('solution/tsconfig.test.json', { compilerOptions: { plugins: [plugin('test')] }, include: ['test'] });
        write('narrow/tsconfig.json', { compilerOptions: { plugins: [plugin('narrow')] }, include: ['src'] });
        write('tsconfig.json', { compilerOptions: { plugins: [plugin('root')] }, include: ['narrow/ancestor'] });
    });

    afterAll(() => fs.removeSync(root));

    it('reads a config\'s feature plugins in a fixed order', () => {
        expect(resolve('direct/file.ts')).toEqual(['a', 'b']);
        expect(pluginSetKey(['b', 'a', 'b'])).toBe('a,b');
    });

    it('follows extends, where a config\'s own plugins replace the inherited ones', () => {
        expect(resolve('extended/file.ts')).toEqual(['inherited']);
        expect(resolve('replaced/file.ts')).toEqual([]);
    });

    it('tolerates comments and broken configs', () => {
        expect(resolve('commented/file.ts')).toEqual(['c']);
        expect(resolve('broken/file.ts')).toEqual([]);
    });

    it('finds the referenced project of a solution that contains the file', () => {
        expect(resolve('solution/src/file.ts')).toEqual(['app']);
        expect(resolve('solution/test/file.ts')).toEqual(['test']);
    });

    it('looks further up when the nearest config does not contain the file, then settles for the nearest', () => {
        expect(resolve('narrow/src/file.ts')).toEqual(['narrow']);
        expect(resolve('narrow/ancestor/file.ts')).toEqual(['root']);
        expect(resolve('narrow/stray/file.ts')).toEqual(['narrow']);
    });

    it('has no plugins for files outside any project and paths that are not on disk', () => {
        const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tspp-plugin-sets-')));
        try {
            expect(resolver.resolve(path.join(outside, 'file.ts'), outside)).toBe('');
            expect(resolver.resolve('^/untitled/ts-nul-authority/Untitled-1')).toBe('');
        } finally {
            fs.removeSync(outside);
        }
    });

    it('does not search above the project root', () => {
        resolver.invalidate();
        expect(resolver.resolve(write('direct/deep/file.ts', 'export {};\n'), path.join(root, 'direct', 'deep'))).toBe('');
    });
});
