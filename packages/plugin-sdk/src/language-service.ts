import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

export interface TSPPQuickInfoRequest {
    readonly fileName: string;
    readonly sourceText: string;
    readonly position: number;
}

export interface TSPPQuickInfo {
    readonly start: number;
    readonly length: number;
    readonly display: string;
    readonly documentation?: string;
}

export type TSPPQuickInfoProvider = (request: TSPPQuickInfoRequest) => TSPPQuickInfo | undefined;

export interface TSPPLanguageServiceHostAPI {
    registerQuickInfoProvider(pluginId: string, provider: TSPPQuickInfoProvider): TSPPPluginDisposer;
}

export interface TSPPLanguageServicePluginAPI {
    registerQuickInfoProvider(provider: TSPPQuickInfoProvider): TSPPPluginDisposer;
}

/** Feature-owned semantic tooling that is transported through tsserver and LSP. */
export interface TSPPLanguageServicePluginContext {
    readonly pluginId: string;
    readonly logger: TSPPPluginLogger;
    readonly languageService: TSPPLanguageServicePluginAPI;
    onDispose(disposer: TSPPPluginDisposer): void;
}

export interface TSPPLanguageServicePlugin {
    activate(context: TSPPLanguageServicePluginContext): void | TSPPPluginDisposer;
}
