import {
    TSPP_PLUGIN_API_VERSION,
    TSPPPlugin,
    TSPPPluginDependencies,
    TSPPPluginDisposer,
    TSPPPluginLogger,
    TSPPPluginManifest,
} from "./index";
import type { TSPPCompilerHostAPI, TSPPCompilerPluginContext, TSPPTypeScript } from "./compiler";
import type { TSPPLanguageServiceHostAPI, TSPPLanguageServicePluginContext } from "./language-service";

export interface TSPPPluginHostEnvironment {
    readonly compilerVersion: string;
    readonly logger: TSPPPluginLogger;
    /** The host compiler's public API, handed to every compiler facet as `context.ts`. */
    readonly ts: TSPPTypeScript;
    readonly compiler: TSPPCompilerHostAPI;
    readonly languageService?: TSPPLanguageServiceHostAPI;
}

interface PluginRegistration {
    readonly plugin: TSPPPlugin;
    readonly disposers: TSPPPluginDisposer[];
}

type HostState = "collecting" | "active" | "disposed";

export class TSPPPluginHost {
    private readonly registrations = new Map<string, PluginRegistration>();
    private readonly activationOrder: PluginRegistration[] = [];
    private readonly providedAPIs = new Map<string, unknown>();
    private state: HostState = "collecting";

    public constructor(private readonly environment: TSPPPluginHostEnvironment) {}

    public register(plugin: TSPPPlugin): this {
        if (this.state !== "collecting") {
            throw new Error("TSPP plugins must be registered before host activation.");
        }

        this.addRegistration(plugin);
        return this;
    }

    public list(): readonly TSPPPluginManifest[] {
        return Array.from(this.registrations.values(), registration => registration.plugin.manifest);
    }

    public activateAll(): void {
        if (this.state !== "collecting") {
            throw new Error(`Cannot activate a TSPP plugin host in state '${this.state}'.`);
        }
        const activationOrder = resolveActivationOrder(this.registrations);
        this.state = "active";

        for (const registration of activationOrder) {
            try {
                this.activateFacets(registration);
                this.activationOrder.push(registration);
            }
            catch (cause) {
                try {
                    disposeRegistration(registration);
                }
                catch {
                    // Preserve the activation failure while still rolling back earlier plugins.
                }
                try {
                    this.dispose();
                }
                catch {
                    // Preserve the activation failure; cleanup is best-effort on this path.
                }
                throw new TSPPPluginActivationError(registration.plugin.manifest.id, cause);
            }
        }
    }

    /** Registers a feature discovered after the process-level host started. */
    public registerAndActivate(plugin: TSPPPlugin): this {
        if (this.state === "collecting") return this.register(plugin);
        if (this.state !== "active") {
            throw new Error(`Cannot register a TSPP plugin host in state '${this.state}'.`);
        }

        const registration = this.addRegistration(plugin);
        try {
            validateActiveDependencies(registration, this.registrations, this.activationOrder);
            this.activateFacets(registration);
            this.activationOrder.push(registration);
            return this;
        }
        catch (cause) {
            try {
                disposeRegistration(registration);
            }
            finally {
                this.registrations.delete(plugin.manifest.id);
            }
            throw new TSPPPluginActivationError(plugin.manifest.id, cause);
        }
    }

    public dispose(): void {
        if (this.state === "disposed") return;
        this.state = "disposed";

        let firstError: unknown;
        for (let index = this.activationOrder.length - 1; index >= 0; index--) {
            try {
                disposeRegistration(this.activationOrder[index]);
            }
            catch (error) {
                firstError ??= error;
            }
        }
        this.activationOrder.length = 0;
        if (firstError !== undefined) throw firstError;
    }

    private activateFacets(registration: PluginRegistration): void {
        const compilerDisposer = registration.plugin.facets.compiler?.activate(this.createCompilerContext(registration));
        if (compilerDisposer) registration.disposers.push(compilerDisposer);
        if (this.environment.languageService) {
            const languageServiceDisposer = registration.plugin.facets.languageService?.activate(
                this.createLanguageServiceContext(registration, this.environment.languageService),
            );
            if (languageServiceDisposer) registration.disposers.push(languageServiceDisposer);
        }
    }

    private createCompilerContext(registration: PluginRegistration): TSPPCompilerPluginContext {
        const pluginId = registration.plugin.manifest.id;
        return {
            compilerVersion: this.environment.compilerVersion,
            pluginId,
            logger: prefixLogger(this.environment.logger, pluginId),
            ts: this.environment.ts,
            dependencies: this.createDependencies(registration),
            provide: (name, api) => {
                if (!registration.plugin.manifest.provides?.includes(name)) {
                    throw new Error(`TSPP plugin '${pluginId}' must declare '${name}' in provides before providing it.`);
                }
                if (this.providedAPIs.has(name)) throw new Error(`TSPP plugin '${pluginId}' already provided '${name}'.`);
                this.providedAPIs.set(name, api);
                registration.disposers.push(() => this.providedAPIs.delete(name));
            },
            compiler: {
                expressionSyntaxKinds: this.environment.compiler.expressionSyntaxKinds,
                declarationSyntaxKinds: this.environment.compiler.declarationSyntaxKinds,
                typeSyntaxKinds: this.environment.compiler.typeSyntaxKinds,
                registerExpressionSyntax: syntax => this.environment.compiler.registerExpressionSyntax(pluginId, syntax),
                registerFunctionBodySyntax: syntax => this.environment.compiler.registerFunctionBodySyntax(pluginId, syntax),
                registerTrailingClosureBindingSyntax: syntax =>
                    this.environment.compiler.registerTrailingClosureBindingSyntax(pluginId, syntax),
                registerDeepReadonlyBindingSyntax: syntax =>
                    this.environment.compiler.registerDeepReadonlyBindingSyntax(pluginId, syntax),
                registerDeclarationSyntax: syntax => this.environment.compiler.registerDeclarationSyntax(pluginId, syntax),
                registerTypeSyntax: syntax => this.environment.compiler.registerTypeSyntax(pluginId, syntax),
                registerPostfixTypeSyntax: syntax => this.environment.compiler.registerPostfixTypeSyntax(pluginId, syntax),
                registerKindAnnotationSyntax: syntax =>
                    this.environment.compiler.registerKindAnnotationSyntax(pluginId, syntax),
                registerInterfaceMemberContract: contract =>
                    this.environment.compiler.registerInterfaceMemberContract(pluginId, contract),
                registerProgramAnalyzer: analyzer => this.environment.compiler.registerProgramAnalyzer(pluginId, analyzer),
                registerSourcePreprocessor: preprocessor => this.environment.compiler.registerSourcePreprocessor(pluginId, preprocessor),
                registerExpressionRewriter: rewriter => this.environment.compiler.registerExpressionRewriter(pluginId, rewriter),
                registerCompileTimeMacros: () => this.environment.compiler.registerCompileTimeMacros(pluginId),
            },
            onDispose: disposer => registration.disposers.push(disposer),
        };
    }

    private createDependencies(registration: PluginRegistration): TSPPPluginDependencies {
        const manifest = registration.plugin.manifest;
        const declared = new Set([...(manifest.requires ?? []), ...(manifest.optionalDependencies ?? [])]);
        return {
            get: <T>(name: string): T | undefined => {
                const provider = Array.from(this.registrations.values())
                    .find(candidate => candidate.plugin.manifest.provides?.includes(name));
                if (!provider) return undefined;
                const providerId = provider.plugin.manifest.id;
                if (!declared.has(providerId)) {
                    throw new Error(`TSPP plugin '${manifest.id}' uses '${name}' from '${providerId}' without declaring the dependency.`);
                }
                return this.providedAPIs.get(name) as T | undefined;
            },
        };
    }

    private createLanguageServiceContext(
        registration: PluginRegistration,
        host: TSPPLanguageServiceHostAPI,
    ): TSPPLanguageServicePluginContext {
        const pluginId = registration.plugin.manifest.id;
        return {
            pluginId,
            logger: prefixLogger(this.environment.logger, pluginId),
            languageService: {
                registerQuickInfoProvider: provider => host.registerQuickInfoProvider(pluginId, provider),
            },
            onDispose: disposer => registration.disposers.push(disposer),
        };
    }

    private addRegistration(plugin: TSPPPlugin): PluginRegistration {
        const { manifest } = plugin;
        validateManifest(manifest);
        if (this.registrations.has(manifest.id)) {
            throw new Error(`Duplicate TSPP plugin id: ${manifest.id}`);
        }
        const registration: PluginRegistration = { plugin, disposers: [] };
        this.registrations.set(manifest.id, registration);
        return registration;
    }
}

export class TSPPPluginActivationError extends Error {
    public readonly cause: unknown;

    public constructor(public readonly pluginId: string, cause: unknown) {
        super(`Failed to activate TSPP plugin '${pluginId}': ${cause instanceof Error ? cause.message : String(cause)}`);
        this.name = "TSPPPluginActivationError";
        this.cause = cause;
    }
}

function validateManifest(manifest: TSPPPluginManifest): void {
    if (!manifest.id || manifest.id !== manifest.id.trim()) {
        throw new Error("A TSPP plugin id must be a non-empty trimmed string.");
    }
    if (!manifest.version) {
        throw new Error(`TSPP plugin '${manifest.id}' must declare a version.`);
    }
    if (manifest.apiVersion !== TSPP_PLUGIN_API_VERSION) {
        throw new Error(
            `TSPP plugin '${manifest.id}' requires API ${manifest.apiVersion}; host API is ${TSPP_PLUGIN_API_VERSION}.`,
        );
    }
    const relationships = [
        ["requires", manifest.requires],
        ["optionalDependencies", manifest.optionalDependencies],
        ["provides", manifest.provides],
    ] as const;
    for (const [name, values] of relationships) {
        if (!values) continue;
        if (new Set(values).size !== values.length) throw new Error(`TSPP plugin '${manifest.id}' has duplicate ${name}.`);
        if (values.includes(manifest.id)) throw new Error(`TSPP plugin '${manifest.id}' cannot list itself in ${name}.`);
        if (values.some(value => !value || value !== value.trim())) throw new Error(`TSPP plugin '${manifest.id}' has an invalid ${name} id.`);
    }
}

function resolveActivationOrder(registrations: ReadonlyMap<string, PluginRegistration>): readonly PluginRegistration[] {
    for (const registration of registrations.values()) validateRelationships(registration, registrations);
    const result: PluginRegistration[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (registration: PluginRegistration): void => {
        const id = registration.plugin.manifest.id;
        if (visited.has(id)) return;
        if (visiting.has(id)) throw new Error(`Cyclic TSPP plugin dependency involving '${id}'.`);
        visiting.add(id);
        for (const dependency of [
            ...(registration.plugin.manifest.requires ?? []),
            ...(registration.plugin.manifest.optionalDependencies ?? []),
        ]) {
            const target = registrations.get(dependency);
            if (target) visit(target);
        }
        visiting.delete(id);
        visited.add(id);
        result.push(registration);
    };
    registrations.forEach(visit);
    return result;
}

function validateRelationships(
    registration: PluginRegistration,
    registrations: ReadonlyMap<string, PluginRegistration>,
): void {
    const manifest = registration.plugin.manifest;
    for (const dependency of manifest.requires ?? []) {
        if (!registrations.has(dependency)) throw new Error(`TSPP plugin '${manifest.id}' requires missing plugin '${dependency}'.`);
    }
    for (const other of registrations.values()) {
        if (other === registration) continue;
        const shared = manifest.provides?.find(name => other.plugin.manifest.provides?.includes(name));
        if (shared) throw new Error(`TSPP plugins '${manifest.id}' and '${other.plugin.manifest.id}' both provide '${shared}'.`);
    }
}

function validateActiveDependencies(
    registration: PluginRegistration,
    registrations: ReadonlyMap<string, PluginRegistration>,
    active: readonly PluginRegistration[],
): void {
    validateRelationships(registration, registrations);
    const activeIds = new Set(active.map(item => item.plugin.manifest.id));
    for (const dependency of registration.plugin.manifest.requires ?? []) {
        if (!activeIds.has(dependency)) throw new Error(`TSPP plugin '${registration.plugin.manifest.id}' requires inactive plugin '${dependency}'.`);
    }
}

function disposeRegistration(registration: PluginRegistration): void {
    let firstError: unknown;
    for (let index = registration.disposers.length - 1; index >= 0; index--) {
        try {
            registration.disposers[index]();
        }
        catch (error) {
            firstError ??= error;
        }
    }
    registration.disposers.length = 0;
    if (firstError !== undefined) throw firstError;
}

function prefixLogger(logger: TSPPPluginLogger, pluginId: string): TSPPPluginLogger {
    const prefix = `[${pluginId}] `;
    return {
        debug: message => logger.debug(prefix + message),
        info: message => logger.info(prefix + message),
        warn: message => logger.warn(prefix + message),
        error: message => logger.error(prefix + message),
    };
}
