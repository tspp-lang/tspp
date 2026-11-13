import { createRequire } from 'node:module';
import path from 'node:path';
import type { ts } from '../ts-protocol.js';

type TypeScriptModule = typeof ts & {
    resolveTSPPConfigFileProjectName?: (project: string) => string;
    createTSPPConfigHost?: <T extends object>(host: T) => T;
};

function productConfigApi(ts: TypeScriptModule) {
    const { createTSPPConfigHost, resolveTSPPConfigFileProjectName } = ts;
    if (!createTSPPConfigHost || !resolveTSPPConfigFileProjectName) {
        throw new Error('The selected TS++ SDK does not support tsppconfig.json. Rebuild or update the TS++ SDK.');
    }
    return { createTSPPConfigHost, resolveTSPPConfigFileProjectName };
}

interface ParsedConfig {
    readonly plugins: readonly string[];
    readonly fileNames: ReadonlySet<string>;
    readonly references: readonly string[];
    readonly tspp: boolean;
}

/**
 * Config reads are shared for this long, so that restoring many tabs or checking every open file does not scan the
 * project's directories once per file.
 */
const configCacheLifetime = 2000;

/** The key of a plugin set: the names in a fixed order, so that two projects declaring the same plugins share a key. */
export function pluginSetKey(plugins: readonly string[]): string {
    return [...new Set(plugins)].sort().join(',');
}

export function pluginsOfKey(key: string): readonly string[] {
    return key ? key.split(',') : [];
}

/**
 * Answers which TS++ feature plugins apply to a file, with the compiler's own config parsing so that `extends`,
 * `include`, and project references mean what they mean to the project that will compile the file.
 */
export class PluginSetResolver {
    private configs = new Map<string, ParsedConfig>();
    private configsReadAt = 0;

    private constructor(private readonly ts: TypeScriptModule) {}

    /** The resolver for the compiler next to `tsServerPath`; undefined when that compiler cannot be loaded. */
    public static load(tsServerPath: string): PluginSetResolver | undefined {
        try {
            const require = createRequire(import.meta.url);
            return new PluginSetResolver(require(path.join(path.dirname(tsServerPath), 'typescript.js')) as TypeScriptModule);
        } catch {
            return undefined;
        }
    }

    /** Forgets what config files said; the next answer reads them again. */
    public invalidate(): void {
        this.configs.clear();
    }

    /**
     * The key of the plugin set of the project tsserver will choose for `file`: the nearest config that contains it,
     * directly or through its references, searching no higher than `projectRootPath`. A file no config contains, such
     * as one a project imports from outside its `include`, takes the plugins of its nearest config.
     */
    public resolve(file: string, projectRootPath?: string): string {
        if (!path.isAbsolute(file)) {
            return '';
        }
        if (Date.now() - this.configsReadAt > configCacheLifetime) {
            this.invalidate();
            this.configsReadAt = Date.now();
        }
        const normalizedFile = this.normalize(file);
        const tspp = /\.tspp$/i.test(file) || /^tsppconfig(?:\..+)?\.json$/i.test(path.basename(file));
        if (/^tsppconfig(?:\..+)?\.json$/i.test(path.basename(file)) && this.ts.sys.fileExists(file)) {
            return pluginSetKey(this.read(file, true).plugins);
        }
        let nearest: ParsedConfig | undefined;
        for (const configPath of this.configsAbove(file, projectRootPath, tspp)) {
            const config = this.read(configPath, tspp);
            nearest ??= config;
            const containing = this.findContaining(config, normalizedFile, new Set([configPath]));
            if (containing) {
                return pluginSetKey(containing.plugins);
            }
        }
        return pluginSetKey(nearest?.plugins ?? []);
    }

    private* configsAbove(file: string, projectRootPath: string | undefined, tspp: boolean): Generator<string> {
        const directories: string[] = [];
        for (let directory = path.dirname(file); ; directory = path.dirname(directory)) {
            directories.push(directory);
            if (directory === path.dirname(directory)) {
                break;
            }
        }
        const rootIndex = projectRootPath ? directories.indexOf(path.resolve(projectRootPath)) : -1;
        for (const directory of rootIndex < 0 ? directories : directories.slice(0, rootIndex + 1)) {
            const configPath = (tspp ? ['tsppconfig.json'] : ['tsconfig.json', 'jsconfig.json'])
                .map(name => path.join(directory, name)).find(candidate => this.ts.sys.fileExists(candidate));
            if (configPath) {
                yield configPath;
            }
        }
    }

    private findContaining(config: ParsedConfig, file: string, visited: Set<string>): ParsedConfig | undefined {
        if (config.fileNames.has(file)) {
            return config;
        }
        for (const reference of config.references) {
            if (!visited.has(reference) && this.ts.sys.fileExists(reference)) {
                visited.add(reference);
                const containing = this.findContaining(this.read(reference, config.tspp), file, visited);
                if (containing) {
                    return containing;
                }
            }
        }
        return undefined;
    }

    private read(configPath: string, tspp: boolean): ParsedConfig {
        const key = `${tspp ? 'tspp' : 'ts'}:${configPath}`;
        let config = this.configs.get(key);
        if (!config) {
            // TypeScript diagnostics require normalized paths, including when the JSON is malformed.
            const tsConfigPath = configPath.replaceAll('\\', '/');
            const json = this.ts.readConfigFile(tsConfigPath, file => this.ts.sys.readFile(file)).config as object | undefined;
            const product = tspp ? productConfigApi(this.ts) : undefined;
            const host = product ? product.createTSPPConfigHost(this.ts.sys) : this.ts.sys;
            const parsed = this.ts.parseJsonConfigFileContent(json ?? {}, host, path.posix.dirname(tsConfigPath), undefined, tsConfigPath);
            // The same entries the command line loads: the `tspp` flag is what makes a plugin a feature plugin.
            const plugins = (parsed.options.plugins ?? []) as readonly { name?: unknown; tspp?: unknown; }[];
            config = {
                plugins: plugins.filter(plugin => plugin.tspp && typeof plugin.name === 'string').map(plugin => plugin.name as string),
                fileNames: new Set(parsed.fileNames.map(fileName => this.normalize(fileName))),
                references: (parsed.projectReferences ?? []).map(reference => {
                    const referencePath = path.resolve(reference.path);
                    if (product) {
                        return product.resolveTSPPConfigFileProjectName(referencePath);
                    }
                    return path.resolve(this.ts.resolveProjectReferencePath(reference));
                }),
                tspp,
            };
            this.configs.set(key, config);
        }
        return config;
    }

    private normalize(file: string): string {
        const resolved = path.resolve(file);
        return this.ts.sys.useCaseSensitiveFileNames ? resolved : resolved.toLowerCase();
    }
}
