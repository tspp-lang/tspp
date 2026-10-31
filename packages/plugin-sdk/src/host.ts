import {
    TSPP_PLUGIN_API_VERSION,
    TSPPPlugin,
    TSPPPluginDisposer,
    TSPPPluginLogger,
    TSPPPluginManifest,
} from "./index";
import type { TSPPCompilerHostAPI, TSPPCompilerPluginContext } from "./compiler";

export interface TSPPPluginHostEnvironment {
    readonly compilerVersion: string;
    readonly logger: TSPPPluginLogger;
    readonly compiler: TSPPCompilerHostAPI;
}

interface PluginRegistration {
    readonly plugin: TSPPPlugin;
    readonly disposers: TSPPPluginDisposer[];
}

type HostState = "collecting" | "active" | "disposed";

export class TSPPPluginHost {
    private readonly registrations = new Map<string, PluginRegistration>();
    private readonly activationOrder: PluginRegistration[] = [];
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
        this.state = "active";

        for (const registration of this.registrations.values()) {
            try {
                const disposer = registration.plugin.facets.compiler?.activate(this.createContext(registration));
                if (disposer) registration.disposers.push(disposer);
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
            const disposer = plugin.facets.compiler?.activate(this.createContext(registration));
            if (disposer) registration.disposers.push(disposer);
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

    private createContext(registration: PluginRegistration): TSPPCompilerPluginContext {
        const pluginId = registration.plugin.manifest.id;
        return {
            compilerVersion: this.environment.compilerVersion,
            pluginId,
            logger: prefixLogger(this.environment.logger, pluginId),
            compiler: {
                expressionSyntaxKinds: this.environment.compiler.expressionSyntaxKinds,
                registerExpressionSyntax: syntax => this.environment.compiler.registerExpressionSyntax(pluginId, syntax),
                registerProgramAnalyzer: analyzer => this.environment.compiler.registerProgramAnalyzer(pluginId, analyzer),
                registerSourcePreprocessor: preprocessor => this.environment.compiler.registerSourcePreprocessor(pluginId, preprocessor),
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
        super(`Failed to activate TSPP plugin '${pluginId}'.`);
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
