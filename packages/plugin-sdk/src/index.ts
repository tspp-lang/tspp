import type { TSPPCompilerPlugin } from "./compiler";
import type { TSPPEditorContribution } from "./editor";
import type { TSPPLanguageServicePlugin } from "./language-service";
import type { TSPPLSPPlugin } from "./lsp";

/** The plugin contract version understood by this host generation. */
export const TSPP_PLUGIN_API_VERSION = 1 as const;

export interface TSPPPluginManifest {
    /** Stable, repository-wide identity such as `modern-syntax/let-in`. */
    readonly id: string;
    /** Version of the feature package, not the compiler. */
    readonly version: string;
    /** Exact SDK contract expected by the feature package. */
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

/** A complete feature capsule. Each runtime loads only the facet it owns. */
export interface TSPPPlugin {
    readonly manifest: TSPPPluginManifest;
    readonly facets: {
        readonly compiler?: TSPPCompilerPlugin;
        readonly languageService?: TSPPLanguageServicePlugin;
        readonly lsp?: TSPPLSPPlugin;
        readonly editor?: TSPPEditorContribution;
    };
}

/** Gives feature packages contextual typing without wrapping or mutating them. */
export function definePlugin<const T extends TSPPPlugin>(plugin: T): T {
    return plugin;
}
