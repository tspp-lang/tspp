import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

/** Base lifecycle for feature-owned language-service contributions. */
export interface TSPPLanguageServicePluginContext {
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;
    onDispose(disposer: TSPPPluginDisposer): void;
}

export interface TSPPLanguageServicePlugin {
    activate(context: TSPPLanguageServicePluginContext): void | TSPPPluginDisposer;
}
