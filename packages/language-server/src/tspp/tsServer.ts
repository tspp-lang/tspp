import type { TsClientOptions } from '../ts-client.js';
import type { ITypeScriptServer } from '../tsServer/server.js';
import type { PluginManager } from '../tsServer/plugins.js';
import { SyntaxServerConfiguration } from '../utils/configuration.js';
import type { Logger } from '../utils/logger.js';
import { PluginSetRoutingTsServer } from './pluginSetRouting.js';
import { PluginSetResolver, pluginsOfKey } from './pluginSets.js';

/** The plugin set each spawn was asked for, kept beside the options so that upstream signatures stay as they are. */
const pluginSetOfOptions = new WeakMap<TsClientOptions, readonly string[]>();

export interface TsServerHost {
    readonly options: TsClientOptions;
    readonly workspaceRoot: string | undefined;
    readonly logger: Logger;
    getDocumentText(file: string): string | undefined;
    /** Spawns one tsserver (or upstream's composite of them) with these options. */
    spawn(options: TsClientOptions): ITypeScriptServer;
}

/**
 * One tsserver per plugin set behind a single server, or one shared server when the plugin sets cannot be read
 * (docs/plugin-framework.md, "Current process boundary").
 */
export function createTsServer(host: TsServerHost): ITypeScriptServer {
    const { options, workspaceRoot, logger } = host;
    const spawn = (pluginSet?: readonly string[]) => {
        if (!pluginSet) {
            return host.spawn(options);
        }
        const withPluginSet = { ...options };
        pluginSetOfOptions.set(withPluginSet, pluginSet);
        return host.spawn(withPluginSet);
    };
    // A syntax server never loads a project, so it never activates a plugin.
    const pluginSets = options.useSyntaxServer === SyntaxServerConfiguration.Always ? undefined : PluginSetResolver.load(options.typescriptVersion.tsServerPath);
    if (!pluginSets) {
        logger.info('Projects share one tsserver: no compiler to read their plugin sets with');
        return spawn();
    }
    return new PluginSetRoutingTsServer({
        spawn: key => spawn(pluginsOfKey(key)),
        resolve: (file, projectRootPath) => pluginSets.resolve(file, projectRootPath ?? workspaceRoot),
        invalidate: () => pluginSets.invalidate(),
        getDocumentText: file => host.getDocumentText(file),
        workspaceRoot,
    });
}

/** The tsserver arguments TS++ adds to upstream's. */
export function tsServerArgs(options: TsClientOptions, pluginManager: PluginManager): string[] {
    // TS++ feature packages are project dependencies declared by the project's tsconfig, so resolve them from that
    // project before falling back to global probe locations.
    const args = ['--allowLocalPluginLoads'];
    // The only TS++ feature plugins this server may activate, whatever configs it comes across while searching for a
    // file's project or following references. Plugins the client configured are global by request.
    const pluginSet = pluginSetOfOptions.get(options);
    if (pluginSet) {
        args.push('--tsppPluginSet', [...pluginSet, ...pluginManager.plugins.map(x => x.name)].join(','));
    }
    return args;
}
