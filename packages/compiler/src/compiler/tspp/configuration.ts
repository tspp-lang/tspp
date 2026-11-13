import {
    combinePaths,
    Extension,
    fileExtensionIs,
    getBaseFileName,
    getNormalizedAbsolutePath,
    isRootedDiskPath,
    createCompilerDiagnostic,
    DiagnosticCategory,
} from "../_namespaces/ts.js";
import type { CompilerOptions, Diagnostic, ExtendedConfigCacheEntry, FileExtensionInfo, ParseConfigHost, Path, ResolvedConfigFileName, System } from "../_namespaces/ts.js";

/** @internal */
export const tsppConfigFileName = "tsppconfig.json";
const productHosts = new WeakSet<object>();
const productOptions = new WeakSet<CompilerOptions>();
const productCachePrefix = "\0tspp:";

/** Product host selection does not change the defaults of the TypeScript public API. @internal */
export function inheritTSPPConfigHost<T extends object>(host: T, source?: object): T {
    if (!source || isTSPPConfigHost(source)) productHosts.add(host);
    return host;
}

/** @internal */
export function isTSPPConfigHost(host: object): boolean {
    for (let current = host; current; current = Object.getPrototypeOf(current)) {
        if (productHosts.has(current)) return true;
    }
    return false;
}

/** @internal */
export function getTSPPHostConfigName(host: object): string {
    return isTSPPConfigHost(host) ? tsppConfigFileName : "tsconfig.json";
}

/** Names recognized when a TS++ project is opened directly in a language server. @internal */
export function isTSPPConfigFile(fileName: string | undefined): boolean {
    return !!fileName && /^tsppconfig(?:\.[^/\\]+)?\.json$/i.test(getBaseFileName(fileName));
}

/** @internal */
export function getTSPPParseConfigHost<T extends ParseConfigHost>(host: T, fileName: string | undefined): T {
    return isTSPPConfigFile(fileName) && !isTSPPConfigHost(host) ? inheritTSPPConfigHost<T>(Object.create(host)) : host;
}

/** Keep explicit custom JSON origins on the parsed options, never on a process-wide pathname. @internal */
export function registerTSPPConfigOptions(options: CompilerOptions, host: ParseConfigHost): void {
    if (isTSPPConfigHost(host)) productOptions.add(options);
}

/** @internal */
export function isTSPPConfigOptions(options: CompilerOptions): boolean {
    return productOptions.has(options) || isTSPPConfigFile(options.configFilePath);
}

function permitsTSPPFiles(host: object, fileName: string | undefined, extra: readonly FileExtensionInfo[] | undefined): boolean {
    return isTSPPConfigHost(host) || isTSPPConfigFile(fileName) || !!extra?.some(extension => extension.extension === Extension.Tspp);
}

/** Ordinary configuration discovery has exactly the upstream extensions unless its caller opts in. @internal */
export function getTSPPConfigExtensions<T extends string>(extensions: readonly T[][], host: object, fileName: string | undefined, extra: readonly FileExtensionInfo[]): readonly T[][] {
    return permitsTSPPFiles(host, fileName, extra) ? extensions : extensions.map(group => group.filter(extension => extension !== Extension.Tspp));
}

/** A configured ordinary program must not admit TS++ through triple-slash references either. @internal */
export function getTSPPProgramExtensions<T extends string>(extensions: readonly T[][], host: object, options: CompilerOptions): readonly T[][] {
    return options.configFilePath && !isTSPPConfigOptions(options) ? getTSPPConfigExtensions(extensions, host, options.configFilePath, []) : extensions;
}

/** Apply to both literal files and wildcard results, including watch-mode filename reloads. @internal */
export function getTSPPConfigFileNames(files: string[], host: ParseConfigHost, fileName: string | undefined, extra: readonly FileExtensionInfo[], options: CompilerOptions): string[] {
    return options.allowNonTsExtensions || permitsTSPPFiles(host, fileName, extra) ? files : files.filter(file => !file.endsWith(Extension.Tspp));
}

/** Explicit literal entries get a diagnostic instead of silently dropping a TS++ root. @internal */
export function validateTSPPConfigFileNames(files: readonly string[] | undefined, host: ParseConfigHost, fileName: string | undefined, extra: readonly FileExtensionInfo[] | undefined, options: CompilerOptions, errors: Diagnostic[]): void {
    if (options.allowNonTsExtensions || permitsTSPPFiles(host, fileName, extra)) return;
    for (const file of files ?? []) {
        if (file.endsWith(Extension.Tspp)) errors.push(createCompilerDiagnostic({ code: 6054, category: DiagnosticCategory.Error, key: "TSPP_source_requires_product_config", message: "File '{0}' has an unsupported extension in a TypeScript project. Use tsppconfig.json for TS++ source files." }, file));
    }
}

/** Keep different directory-default semantics in separate entries of the caller's existing cache. @internal */
export function getTSPPExtendedConfigKey(path: string, host: ParseConfigHost): string {
    return isTSPPConfigHost(host) ? productCachePrefix + path : path;
}

/** Cache recursion passes keys; filesystem watches pass paths. Both invalidate both interpretations. @internal */
export function getTSPPExtendedConfigFilePath(path: Path): Path {
    return (path.startsWith(productCachePrefix) ? path.slice(productCachePrefix.length) : path) as Path;
}

/** @internal */
export function deleteTSPPExtendedConfigEntry(cache: Map<string, ExtendedConfigCacheEntry>, path: Path): boolean {
    const ordinary = cache.delete(path);
    return cache.delete(productCachePrefix + path) || ordinary;
}

/** Resolve an explicitly selected TS++ project; the upstream resolver keeps its TS default. @internal */
export function getTSPPConfigFileProjectName(project: string): ResolvedConfigFileName {
    return (fileExtensionIs(project, Extension.Json) ? project : combinePaths(project, tsppConfigFileName)) as ResolvedConfigFileName;
}

/** Brand only generic config guidance; diagnostic filenames and extends paths retain their actual spelling. @internal */
export function getTSPPConfigDiagnostic(diagnostic: Diagnostic, host: object): Diagnostic {
    if (!isTSPPConfigHost(host) || ![5054, 5057, 5081, 5112, 6064, 6230].includes(diagnostic.code)) return diagnostic;
    const messageText = typeof diagnostic.messageText === "string"
        ? diagnostic.messageText.replace("tsconfig.json", tsppConfigFileName)
        : { ...diagnostic.messageText, messageText: diagnostic.messageText.messageText.replace("tsconfig.json", tsppConfigFileName) };
    return { ...diagnostic, messageText };
}

/** @internal */
export function resolveTSPPHostProjectName(project: string, host: object, resolveOrdinary: (project: string) => ResolvedConfigFileName): ResolvedConfigFileName {
    return isTSPPConfigHost(host) ? getTSPPConfigFileProjectName(project) : resolveOrdinary(project);
}

/** @internal */
export function getTSPPReferencePath(reference: string, basePath: string, host: ParseConfigHost, configFileName: string | undefined, errors: Diagnostic[]): string {
    const path = getNormalizedAbsolutePath(reference, basePath);
    const product = isTSPPConfigFile(configFileName) || isTSPPConfigHost(host);
    if (product && /^(?:tsconfig|jsconfig)\.json$/i.test(getBaseFileName(path))) {
        errors.push(createCompilerDiagnostic({ code: 1005, category: DiagnosticCategory.Error, key: "TSPP_legacy_project_reference", message: "TS++ project references cannot use '{0}'. Use tsppconfig.json." }, reference));
    }
    return product ? getTSPPConfigFileProjectName(path) : path;
}

/** A directory in a TS++ extends clause has one product-specific default. @internal */
export function getTSPPExtendsPath(extendedConfig: string, basePath: string, host: ParseConfigHost, configFileName: string | undefined): string {
    if (!isTSPPConfigFile(configFileName) && !isTSPPConfigHost(host)) return extendedConfig;
    if (!isRootedDiskPath(extendedConfig) && !/^\.\.?[/\\]/.test(extendedConfig)) return extendedConfig;
    const path = getNormalizedAbsolutePath(extendedConfig, basePath);
    return host.directoryExists?.(path) ? combinePaths(path, tsppConfigFileName) : extendedConfig;
}

/** @internal */
export function rejectTSPPLegacyProject(system: System, args: readonly string[]): boolean {
    const legacy = args.find(argument => /(?:^|[/\\])(?:tsconfig|jsconfig)\.json$/i.test(argument));
    if (!legacy) return false;
    system.write(`error TSPP1004: '${legacy}' is a TypeScript project configuration. Use tsppconfig.json for TS++.${system.newLine}`);
    return true;
}
