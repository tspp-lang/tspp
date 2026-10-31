import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

/** Optional lifecycle for capabilities that cannot be expressed by tsserver. */
export interface TSPPLSPPluginContext {
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;
    onDispose(disposer: TSPPPluginDisposer): void;
}

export interface TSPPLSPPlugin {
    activate(context: TSPPLSPPluginContext): void | TSPPPluginDisposer;
}
