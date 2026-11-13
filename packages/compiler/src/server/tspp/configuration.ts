import { combinePaths, containsPath, createTSPPConfigHost, getBaseFileName, getDirectoryPath, isNodeModulesDirectory, isTSPPConfigFile, isTSPPConfigHost, isTSPPConfigOptions, ProgramUpdateLevel, tsppConfigFileName } from "../_namespaces/ts.js";
import type { CompilerOptions } from "../_namespaces/ts.js";
import { asNormalizedPath, normalizedPathToPath } from "../_namespaces/ts.server.js";
import type { ConfigFileExistenceInfo, NormalizedPath } from "../_namespaces/ts.server.js";

/** @internal */
export function isTSPPProjectFile(fileName: string): boolean {
    return fileName.endsWith(".tspp") || isTSPPConfigFile(fileName);
}

/** Retain the referring project's product origin on the cached host used by reference and watch reloads. @internal */
export function getTSPPProjectConfigHost<T extends object>(host: T, options: CompilerOptions, projectName: string, configFileName: string): T {
    if (/^(?:tsconfig|jsconfig)\.json$/i.test(getBaseFileName(configFileName))) return host;
    if (isTSPPConfigHost(host)) return host;
    return isTSPPConfigOptions(options) || isTSPPConfigFile(projectName) ? createTSPPConfigHost(host) : host;
}

/** A newly discovered product reference must not reuse an earlier ordinary interpretation of custom JSON. @internal */
export function refreshTSPPReferencedConfig(info: ConfigFileExistenceInfo, options: CompilerOptions, projectName: string, configFileName: string): void {
    if (/^(?:tsconfig|jsconfig)\.json$/i.test(getBaseFileName(configFileName))) return;
    if (!isTSPPConfigOptions(options) && !isTSPPConfigFile(projectName)) return;
    const cached = info.config?.parsedCommandLine;
    if (cached && !isTSPPConfigOptions(cached.options)) info.config!.updateLevel = ProgramUpdateLevel.Full;
}

/** Use the existing project service cache and watchers, with TS++'s sole default candidate. @internal */
export function forEachTSPPConfigFileLocation(
    fileName: string,
    projectRootPath: NormalizedPath | undefined,
    currentDirectory: string,
    useCaseSensitiveFileNames: boolean,
    toCanonicalFileName: (fileName: string) => string,
    action: (canonicalPath: NormalizedPath, fileName: NormalizedPath) => boolean | void,
    ancestorConfig: boolean,
): NormalizedPath | undefined {
    let searchPath = asNormalizedPath(getDirectoryPath(fileName));
    const inProjectRoot = () => containsPath(projectRootPath!, searchPath, currentDirectory, !useCaseSensitiveFileNames);
    const anySearchPathOk = !projectRootPath || !inProjectRoot();
    let skipSelf = ancestorConfig;
    do {
        const canonicalSearchPath = normalizedPathToPath(searchPath, currentDirectory, toCanonicalFileName);
        const configName = asNormalizedPath(combinePaths(searchPath, tsppConfigFileName));
        if (!skipSelf && action(combinePaths(canonicalSearchPath, tsppConfigFileName) as NormalizedPath, configName)) return configName;
        skipSelf = false;
        if (isNodeModulesDirectory(canonicalSearchPath)) break;
        const parent = asNormalizedPath(getDirectoryPath(searchPath));
        if (parent === searchPath) break;
        searchPath = parent;
    }
    while (anySearchPathOk || inProjectRoot());
    return undefined;
}
