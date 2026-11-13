import path from 'node:path';
import { ServerResponse, type ExecuteInfo, type TypeScriptRequestTypes } from '../typescriptService.js';
import { CommandTypes, EventName, type ts } from '../ts-protocol.js';
import type { ITypeScriptServer, TypeScriptServerExitEvent } from '../tsServer/server.js';

type Responses = Array<Promise<ServerResponse.Response<ts.server.protocol.Response>> | undefined>;

/** A server with no open files is kept this long, so that closing a project's last tab and reopening it costs nothing. */
const defaultIdleTimeout = 60_000;

export interface PluginSetRoutingOptions {
    /** Starts the server for a plugin set. */
    spawn(pluginSetKey: string): ITypeScriptServer;
    /** The plugin set of the project a file belongs to; see `PluginSetResolver.resolve`. */
    resolve(file: string, projectRootPath?: string): string;
    /** Forgets what config files said, before every open file is checked again. */
    invalidate(): void;
    getDocumentText(file: string): string | undefined;
    workspaceRoot: string | undefined;
    idleTimeout?: number;
}

interface Group {
    readonly key: string;
    readonly server: ITypeScriptServer;
    readonly files: Set<string>;
    /** Each process numbers its watchers from the same start, so the client sees ids that are unique across them. */
    readonly watcherIds: Map<number, number>;
    idleTimer?: NodeJS.Timeout;
}

interface OpenFile {
    group: Group;
    readonly open: ts.server.protocol.OpenRequestArgs;
    configure?: ts.server.protocol.ConfigureRequestArguments;
}

function requestFile(args: any): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return args?.file ?? args?.scope?.args?.file ?? args?.oldFilePath ?? args?.command?.file;
}

/**
 * Compiler syntax registration is global to a process, so projects with different TS++ plugins cannot share a tsserver.
 * This looks like one server to the client and keeps one per plugin set behind it, started when a file of that set first
 * opens: a request goes to the server of the file it names, and settings go to all of them, now and when one starts.
 */
export class PluginSetRoutingTsServer implements ITypeScriptServer {
    private readonly groups = new Map<string, Group>();
    private readonly openFiles = new Map<string, OpenFile>();
    private readonly watchers = new Map<number, { readonly group: Group; readonly id: number; }>();
    private nextWatcherId = 1;
    private readonly settings = new Map<string, { readonly command: keyof TypeScriptRequestTypes; readonly args: unknown; }>();
    private readonly eventHandlers = new Set<(event: ts.server.protocol.Event) => any>();
    private readonly exitHandlers = new Set<(event: TypeScriptServerExitEvent) => any>();
    private readonly errorHandlers = new Set<(error: any) => any>();
    private readonly stdErrHandlers = new Set<(error: string) => any>();

    constructor(private readonly options: PluginSetRoutingOptions) {}

    /** The plugin sets with a running server. */
    public get pluginSetKeys(): readonly string[] {
        return [...this.groups.keys()];
    }

    public get tsServerLogFile(): string | undefined {
        return this.groups.values().next().value?.server.tsServerLogFile;
    }

    public onEvent(handler: (event: ts.server.protocol.Event) => any): void {
        this.eventHandlers.add(handler);
    }

    public onExit(handler: (event: TypeScriptServerExitEvent) => any): void {
        this.exitHandlers.add(handler);
    }

    public onError(handler: (error: any) => any): void {
        this.errorHandlers.add(handler);
    }

    public onStdErr(handler: (error: string) => any): void {
        this.stdErrHandlers.add(handler);
    }

    public kill(): void {
        for (const group of this.groups.values()) {
            clearTimeout(group.idleTimer);
            group.server.kill();
        }
        this.groups.clear();
    }

    public dispose(): void {
        for (const group of this.groups.values()) {
            clearTimeout(group.idleTimer);
            group.server.dispose();
        }
        this.groups.clear();
    }

    public executeImpl(command: keyof TypeScriptRequestTypes, args: any, executeInfo: ExecuteInfo): Responses {
        /* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        switch (command) {
            case CommandTypes.Open:
                return this.open(args, executeInfo);
            case CommandTypes.Close:
                return this.close(args, executeInfo);
            case CommandTypes.Geterr:
                return this.getErr(args, executeInfo);
            case CommandTypes.WatchChange:
                return this.watchChange(args, executeInfo);
            case CommandTypes.CompilerOptionsForInferredProjects:
                return this.setting(command, command, args, executeInfo);
            case CommandTypes.ConfigurePlugin:
                return this.setting(`${command}/${args.pluginName}`, command, args, executeInfo);
            case CommandTypes.Configure:
                if (!args?.file) {
                    return this.setting(command, command, args, executeInfo);
                }
                if (this.openFiles.has(args.file)) {
                    this.openFiles.get(args.file)!.configure = args;
                }
                break;
        }
        /* eslint-enable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
        const file = requestFile(args);
        return (file ? this.groupOfFile(file) : this.anyGroup()).server.executeImpl(command, args, executeInfo);
    }

    private open(args: ts.server.protocol.OpenRequestArgs, executeInfo: ExecuteInfo): Responses {
        const group = this.group(this.options.resolve(args.file, args.projectRootPath));
        this.openFiles.set(args.file, { group, open: args });
        this.addFile(group, args.file);
        return group.server.executeImpl(CommandTypes.Open, args, executeInfo);
    }

    private close(args: ts.server.protocol.FileRequestArgs, executeInfo: ExecuteInfo): Responses {
        const group = this.groupOfFile(args.file);
        this.openFiles.delete(args.file);
        const responses = group.server.executeImpl(CommandTypes.Close, args, executeInfo);
        this.removeFile(group, args.file);
        return responses;
    }

    private getErr(args: ts.server.protocol.GeterrRequestArgs, executeInfo: ExecuteInfo): Responses {
        const filesOfGroup = new Map<Group, string[]>();
        for (const file of args.files as string[]) {
            const group = this.groupOfFile(file);
            filesOfGroup.set(group, [...filesOfGroup.get(group) ?? [], file]);
        }
        const responses = [...filesOfGroup].map(([group, files]) => group.server.executeImpl(CommandTypes.Geterr, { ...args, files }, executeInfo)[0]).filter(response => response !== undefined);
        return [Promise.all(responses).then(([first]) => first ?? ServerResponse.NoContent)];
    }

    private watchChange(args: ts.server.protocol.WatchChangeRequestArgs | readonly ts.server.protocol.WatchChangeRequestArgs[], executeInfo: ExecuteInfo): Responses {
        const changesOfGroup = new Map<Group, ts.server.protocol.WatchChangeRequestArgs[]>();
        let configChanged = false;
        for (const change of Array.isArray(args) ? args as readonly ts.server.protocol.WatchChangeRequestArgs[] : [args as ts.server.protocol.WatchChangeRequestArgs]) {
            configChanged ||= [...change.created ?? [], ...change.updated ?? [], ...change.deleted ?? []].some(file => file.endsWith('.json'));
            const watcher = this.watchers.get(change.id);
            if (watcher) {
                changesOfGroup.set(watcher.group, [...changesOfGroup.get(watcher.group) ?? [], { ...change, id: watcher.id }]);
            }
        }
        for (const [group, changes] of changesOfGroup) {
            void group.server.executeImpl(CommandTypes.WatchChange, changes, executeInfo);
        }
        if (configChanged) {
            const moved = this.moveFilesWhosePluginsChanged();
            if (moved.length) {
                this.emit({ seq: 0, type: 'event', event: EventName.projectsUpdatedInBackground, body: { openFiles: moved } });
            }
        }
        return [undefined];
    }

    /** A setting not tied to a file: every running server gets it, and every server started later. */
    private setting(key: string, command: keyof TypeScriptRequestTypes, args: unknown, executeInfo: ExecuteInfo): Responses {
        // Each `configure` may carry only some settings; a later server must see them all.
        const merged = command === CommandTypes.Configure ? { ...this.settings.get(key)?.args as object | undefined, ...args as object } : args;
        this.settings.set(key, { command, args: merged });
        const responses = [...this.groups.values()].map(group => group.server.executeImpl(command, args, executeInfo)[0]);
        return [responses[0] ?? (executeInfo.expectsResult ? Promise.resolve(ServerResponse.NoContent) : undefined)];
    }

    private groupOfFile(file: string): Group {
        return this.openFiles.get(file)?.group ?? this.group(this.options.resolve(file));
    }

    /** Where a request that names no file goes: a running server if any, so that it does not start one for nothing. */
    private anyGroup(): Group {
        const { workspaceRoot } = this.options;
        return [...this.groups.values()].find(group => group.files.size > 0)
            ?? this.groups.values().next().value
            ?? this.group(this.options.resolve(workspaceRoot ? path.join(workspaceRoot, 'file.tspp') : '', workspaceRoot));
    }

    private group(key: string): Group {
        let group = this.groups.get(key);
        if (!group) {
            const server = this.options.spawn(key);
            const started: Group = group = { key, server, files: new Set(), watcherIds: new Map() };
            this.groups.set(key, group);
            server.onEvent(event => this.dispatchEvent(started, event));
            server.onStdErr(error => this.stdErrHandlers.forEach(handler => {
                handler(error);
            }));
            server.onExit(event => {
                this.groupDied(started);
                this.exitHandlers.forEach(handler => {
                    handler(event);
                });
            });
            server.onError(error => {
                this.groupDied(started);
                this.errorHandlers.forEach(handler => {
                    handler(error);
                });
            });
            for (const { command, args } of this.settings.values()) {
                void server.executeImpl(command, args, { isAsync: false, token: undefined, expectsResult: false });
            }
        }
        return group;
    }

    /** The client treats the end of its server as fatal and restarts everything, so nothing may be left running. */
    private groupDied(died: Group): void {
        this.groups.delete(died.key);
        this.kill();
    }

    private addFile(group: Group, file: string): void {
        clearTimeout(group.idleTimer);
        group.idleTimer = undefined;
        group.files.add(file);
    }

    private removeFile(group: Group, file: string): void {
        group.files.delete(file);
        if (group.files.size === 0) {
            clearTimeout(group.idleTimer);
            group.idleTimer = setTimeout(() => this.retireIfIdle(group), this.options.idleTimeout ?? defaultIdleTimeout);
            group.idleTimer.unref?.();
        }
    }

    /** Every tsserver holds a whole program in memory. The last one stays, as the only server always did. */
    private retireIfIdle(group: Group): void {
        if (group.files.size > 0 || this.groups.size < 2 || this.groups.get(group.key) !== group) {
            return;
        }
        this.groups.delete(group.key);
        for (const [id, watcher] of this.watchers) {
            if (watcher.group === group) {
                this.watchers.delete(id);
                this.emit({ seq: 0, type: 'event', event: EventName.closeFileWatcher, body: { id } });
            }
        }
        group.server.kill();
    }

    private dispatchEvent(group: Group, event: ts.server.protocol.Event): void {
        switch (event.event as EventName) {
            case EventName.projectsUpdatedInBackground: {
                const moved = this.moveFilesWhosePluginsChanged();
                const { openFiles } = (event as ts.server.protocol.ProjectsUpdatedInBackgroundEvent).body;
                // Diagnostics are requested for the files named here, which must include those now in another server.
                this.emit(moved.length ? { ...event, body: { openFiles: [...new Set([...openFiles, ...moved])] } } : event);
                return;
            }
            case EventName.createFileWatcher:
            case EventName.createDirectoryWatcher: {
                const { body } = event as ts.server.protocol.CreateFileWatcherEvent;
                const id = this.nextWatcherId++;
                group.watcherIds.set(body.id, id);
                this.watchers.set(id, { group, id: body.id });
                this.emit({ ...event, body: { ...body, id } });
                return;
            }
            case EventName.closeFileWatcher: {
                const { body } = event as ts.server.protocol.CloseFileWatcherEvent;
                const id = group.watcherIds.get(body.id);
                if (id !== undefined) {
                    group.watcherIds.delete(body.id);
                    this.watchers.delete(id);
                    this.emit({ ...event, body: { ...body, id } });
                }
                return;
            }
            default:
                this.emit(event);
        }
    }

    private emit(event: ts.server.protocol.Event): void {
        this.eventHandlers.forEach(handler => {
            handler(event);
        });
    }

    /**
     * A tsserver reports that projects changed after a config did, and a config edit can change a project's plugins.
     * The server cannot adopt them: it refuses plugins outside its set. The files move to the server of their new set.
     */
    private moveFilesWhosePluginsChanged(): string[] {
        this.options.invalidate();
        const moved: string[] = [];
        for (const [file, openFile] of this.openFiles) {
            const key = this.options.resolve(file, openFile.open.projectRootPath);
            const fileContent = key === openFile.group.key ? undefined : this.options.getDocumentText(file);
            if (fileContent === undefined) {
                continue;
            }
            const noResponse = { isAsync: false, token: undefined, expectsResult: false };
            const from = openFile.group;
            void from.server.executeImpl(CommandTypes.Close, { file }, noResponse);
            this.removeFile(from, file);
            const to = this.group(key);
            openFile.group = to;
            this.addFile(to, file);
            void to.server.executeImpl(CommandTypes.Open, { ...openFile.open, fileContent }, noResponse);
            if (openFile.configure) {
                void to.server.executeImpl(CommandTypes.Configure, openFile.configure, noResponse);
            }
            moved.push(file);
        }
        return moved;
    }
}
