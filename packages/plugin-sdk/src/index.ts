/** The only plugin contract version understood by this first host. */
export const TSPP_PLUGIN_API_VERSION = 1 as const;

export interface TSPPPluginManifest {
    /** Stable, repository-wide identity such as `modern-syntax/let-in`. */
    readonly id: string;
    /** Version of the plugin package, not the compiler. */
    readonly version: string;
    /** Exact SDK contract expected by the plugin. */
    readonly apiVersion: typeof TSPP_PLUGIN_API_VERSION;
    readonly displayName?: string;
}

export interface TSPPPluginLogger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export type TSPPPluginDisposer = () => void;

export interface TSPPPluginContext {
    readonly compilerVersion: string;
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;

    /** Registers process-lifetime cleanup owned by this plugin. */
    onDispose(disposer: TSPPPluginDisposer): void;
}

/**
 * A statically linked TSPP plugin.
 *
 * Compiler hook ports intentionally do not exist yet. They will be added to the
 * context only when the first real plugin proves what the boundary must expose.
 */
export interface TSPPPlugin {
    readonly manifest: TSPPPluginManifest;
    activate(context: TSPPPluginContext): void | TSPPPluginDisposer;
}

/** Gives plugin packages contextual typing without wrapping or mutating them. */
export function definePlugin<const T extends TSPPPlugin>(plugin: T): T {
    return plugin;
}
