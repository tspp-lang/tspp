import {
    TSPP_PLUGIN_API_VERSION,
    type TSPPPlugin,
    type TSPPPluginLogger,
} from "@tspp/plugin-sdk";
import { TSPPPluginHost } from "@tspp/plugin-sdk/host";

/**
 * The single static compiler/plugin composition point.
 *
 * Keep this list empty until an independently packaged plugin is introduced.
 * Plugins may import the SDK and public compiler API, but never one another.
 */
const compilerPlugins: readonly TSPPPlugin[] = [];
let pluginHost: TSPPPluginHost | undefined;

const silentLogger: TSPPPluginLogger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

/** @internal */
export function initializeTSPPCompilerPlugins(compilerVersion: string): void {
    if (pluginHost) return;
    pluginHost = new TSPPPluginHost({ compilerVersion, logger: silentLogger });
    for (const plugin of compilerPlugins) {
        if (plugin.manifest.apiVersion !== TSPP_PLUGIN_API_VERSION) {
            throw new Error(`TSPP compiler cannot load plugin '${plugin.manifest.id}' with API ${plugin.manifest.apiVersion}.`);
        }
        pluginHost.register(plugin);
    }
    pluginHost.activateAll();
}
