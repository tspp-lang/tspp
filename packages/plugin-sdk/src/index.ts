import type { TSPPCompilerPlugin } from "./compiler";
import type { TSPPEditorContribution } from "./editor";
import type { TSPPLanguageServicePlugin } from "./language-service";
import type { TSPPLSPPlugin } from "./lsp";

/** The plugin contract version understood by this host generation. */
export const TSPP_PLUGIN_API_VERSION = 3 as const;

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
    /**
     * Names of the APIs this plugin publishes with `context.provide`. At most one installed plugin may provide each
     * name, which is also how two plugins that cannot coexist (for example two solvers) exclude each other.
     */
    readonly provides?: readonly string[];
    /** Stable, human-readable capabilities exposed for tooling and diagnostics. */
    readonly capabilities?: readonly string[];
    /**
     * The syntax this plugin claims, which editor builds read without activating it. The host refuses conflicting
     * claims as plugins register their syntax, and repository checks compare this list with what they register.
     */
    readonly syntax?: TSPPSyntaxDeclaration;
}

/**
 * Where a keyword or token starts plugin syntax. Two plugins may use the same word in different positions, such as
 * `let` in an expression and `let` in a type, but never in the same one.
 */
export type TSPPSyntaxPosition =
    | "expression"
    | "primary-expression"
    | "argument"
    | "statement"
    | "function-body"
    | "declaration"
    | "type"
    | "postfix-type"
    | "type-parameter-annotation"
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

/** The APIs of the plugins this plugin declared in `requires` or `optionalDependencies`. */
export interface TSPPPluginDependencies {
    /**
     * Returns the API a declared dependency published under `name`, or undefined when that dependency is optional and
     * not installed. Types come from the provider package's `./api` subpath, imported with `import type` only. Hosts
     * may register an optional dependency after this plugin activates, so read optional APIs when they are needed
     * rather than once during activation.
     */
    get<T>(name: string): T | undefined;
}

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

export { maskNonCode } from "./text";

/** Gives feature packages contextual typing without wrapping or mutating them. */
export function definePlugin<const T extends TSPPPlugin>(plugin: T): T {
    return plugin;
}
