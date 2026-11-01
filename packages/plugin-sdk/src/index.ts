import type { TSPPCompilerPlugin } from "./compiler";
import type { TSPPEditorContribution } from "./editor";
import type { TSPPLanguageServicePlugin } from "./language-service";
import type { TSPPLSPPlugin } from "./lsp";

/** The plugin contract version understood by this host generation. */
export const TSPP_PLUGIN_API_VERSION = 1 as const;

export interface TSPPPluginManifest {
    /** Stable, repository-wide identity such as `modern-syntax`. */
    readonly id: string;
    /** Version of the feature package, not the compiler. */
    readonly version: string;
    /** Exact SDK contract expected by the feature package. */
    readonly apiVersion: typeof TSPP_PLUGIN_API_VERSION;
    readonly displayName?: string;
    /** Plugin ids that must be installed and activated first. */
    readonly requires?: readonly string[];
    /** Plugin ids that are ordered first when present, but are not required. */
    readonly optionalDependencies?: readonly string[];
    /** Plugin ids that cannot coexist with this capsule. */
    readonly conflicts?: readonly string[];
    /** Stable, human-readable capabilities exposed for tooling and diagnostics. */
    readonly capabilities?: readonly string[];
    /** The syntax this plugin claims. Repository checks compare it across plugins; the host trusts it as written. */
    readonly syntax?: TSPPSyntaxDeclaration;
}

/**
 * Where a keyword or token starts plugin syntax. Two plugins may use the same word in different positions, such as
 * `let` in an expression and `let` in a type, but never in the same one.
 */
export type TSPPSyntaxPosition =
    | "expression"
    | "statement"
    | "declaration"
    | "type"
    | "postfix-type"
    | "type-parameter"
    | "type-alias-annotation"
    | "function-clause"
    | "loop-clause"
    | "type-clause"
    | "interface-member";

export interface TSPPSyntaxKeyword {
    /** The word or token that starts the syntax, such as `match` or `_`. */
    readonly keyword: string;
    readonly position: TSPPSyntaxPosition;
}

export interface TSPPSyntaxDeclaration {
    readonly keywords: readonly TSPPSyntaxKeyword[];
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
