import type { TSPPPluginDisposer, TSPPPluginLogger } from "./index";

export interface TSPPQuickInfoRequest {
    readonly fileName: string;
    readonly sourceText: string;
    readonly position: number;
    /**
     * Whether the position is inside syntax this plugin parsed or projected. Providers are asked innermost owner first,
     * then the rest in plugin id order, so answer for a keyword of your own syntax only when this is true.
     */
    readonly owned: boolean;
    /** Source-level word under the cursor, when one exists. */
    readonly token?: TSPPQuickInfoToken;
    /** Best semantic type available before feature-specific formatting. */
    readonly semanticType?: string;
    /** Quick info produced by the underlying TypeScript language service. */
    readonly upstream?: TSPPQuickInfoBase;
}

export interface TSPPQuickInfoToken {
    readonly start: number;
    readonly length: number;
    readonly text: string;
}

export interface TSPPQuickInfoBase {
    readonly display: string;
    readonly kind: string;
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
