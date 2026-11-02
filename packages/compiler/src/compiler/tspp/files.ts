import { fileExtensionIs } from "../_namespaces/ts.js";
import type { ModuleResolutionState } from "../_namespaces/ts.js";
import { Extension } from "../types.js";

// TS++ files: `.tspp` sources, `.d.tspp` declarations with a TypeScript-compatible `.d.ts` beside them, and module
// resolution that lets TS++ sources prefer those surfaces (`TSPP-SLOT(tspp-extension)`, `TSPP-SLOT(module-resolution)`,
// `TSPP-SLOT(declaration-output)` sites).

/** Whether a file is a TS++ source or declaration file. @internal */
export function isTSPPSourceFile(fileName: string): boolean {
    return fileExtensionIs(fileName, Extension.Tspp);
}

/** The TypeScript-compatible declaration file emitted beside a `.d.tspp` declaration file. @internal */
export function getTSPPCompatibilityDeclarationFilePath(declarationFilePath: string | undefined): string | undefined {
    return declarationFilePath && fileExtensionIs(declarationFilePath, ".d.tspp")
        ? declarationFilePath.slice(0, -".d.tspp".length) + Extension.Dts
        : undefined;
}

/**
 * The files a module specifier with `originalExtension` may name when TS++ files take part, or `false` when the
 * upstream rules apply unchanged. Only TS++ sources resolve `.tspp` and `.d.tspp` files; they also reach them behind
 * an emitted `.js` path or an extensionless specifier, preferring `.d.tspp` over the compatible `.d.ts`.
 * `typeScript`, `declaration`, and `javaScript` are the requested kinds of file; `tryExtension` probes one extension.
 * @internal
 */
export function tryAddingTSPPExtensions<T>(
    originalExtension: string,
    state: ModuleResolutionState,
    typeScript: number,
    declaration: number,
    javaScript: number,
    tryExtension: (extension: string, resolvedUsingTsExtension?: boolean) => T | undefined,
): T | undefined | false {
    switch (originalExtension) {
        case Extension.Tspp:
            if (!state.isTsppSource) return undefined;
            return typeScript && tryExtension(Extension.Tspp, /*resolvedUsingTsExtension*/ true)
                || declaration && tryExtension(".d.tspp")
                || declaration && tryExtension(Extension.Dts)
                || undefined;
        case ".d.tspp":
            if (!state.isTsppSource) return undefined;
            return declaration && tryExtension(".d.tspp") || undefined;
        case Extension.Js:
            if (!state.isTsppSource) return false;
            return typeScript && (tryExtension(Extension.Ts, /*resolvedUsingTsExtension*/ false) || tryExtension(Extension.Tsx, /*resolvedUsingTsExtension*/ false))
                // A TS++ source reaches the TS++ file or declarations behind an emitted `.js` path, as `.ts` files do.
                || (typeScript && tryExtension(Extension.Tspp) || declaration && tryExtension(".d.tspp"))
                || declaration && tryExtension(Extension.Dts, /*resolvedUsingTsExtension*/ false)
                || javaScript && (tryExtension(Extension.Js) || tryExtension(Extension.Jsx))
                || state.isConfigLookup && tryExtension(Extension.Json)
                || undefined;
        case "":
            if (!state.isTsppSource) return false;
            return typeScript && (tryExtension(Extension.Ts) || tryExtension(Extension.Tsx) || tryExtension(Extension.Tspp))
                // Built TS++ output carries both declaration forms; TS++ sources need the one that keeps plugin types.
                || declaration && (tryExtension(".d.tspp") || tryExtension(Extension.Dts))
                || javaScript && (tryExtension(Extension.Js) || tryExtension(Extension.Jsx))
                || state.isConfigLookup && tryExtension(Extension.Json)
                || undefined;
        default:
            return false;
    }
}
