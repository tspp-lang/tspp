import * as ts from "ts-plus-plus/source";
import type { RunnableModule, RunnableProgram } from "../protocol";

/**
 * The JavaScript of a module and of everything it imports, for Run. A module in the runtime worker has no address that
 * relative imports or package names could resolve against, so each import says which module it means. The project's
 * files emit as they do for the outputs; packages are outside what a program emits, and transpile on their own.
 */
export function createRunnableProgram(
  program: ts.Program,
  entry: string,
  options: ts.CompilerOptions,
  host: ts.ModuleResolutionHost,
): RunnableProgram {
  const modules: Record<string, RunnableModule> = {};
  const mixedModules = options.module === ts.ModuleKind.Node16 || options.module === ts.ModuleKind.NodeNext;
  const commonJsRun = options.module === ts.ModuleKind.CommonJS || mixedModules;
  const emit = (sourceFile: ts.SourceFile): string | undefined => {
    let javascript: string | undefined;
    if (program.isSourceFileFromExternalLibrary(sourceFile)) {
      javascript = ts.transpileModule(host.readFile(sourceFile.fileName) ?? sourceFile.text, {
        compilerOptions: options,
        fileName: sourceFile.fileName,
      }).outputText;
    }
    else {
      program.emit(sourceFile, (outputName, content) => {
        if (outputName.endsWith(".js")) javascript = content;
      });
    }
    // NodeNext can emit a mixed ESM/CommonJS graph based on package boundaries. The browser runner has no Node
    // package loader, so normalize that already-transformed JavaScript to one CommonJS graph for execution only.
    // CommonJS already has that format, so avoid building another program just to transpile it again.
    return javascript && mixedModules
      ? ts.transpileModule(javascript, {
          compilerOptions: { allowJs: true, module: ts.ModuleKind.CommonJS, target: options.target },
          fileName: sourceFile.fileName.replace(/\.(?:tspp|ts)$/, ".js"),
        }).outputText
      : javascript;
  };
  const visit = (fileName: string): void => {
    if (modules[fileName]) return;
    const sourceFile = program.getSourceFile(fileName);
    const code = sourceFile && !sourceFile.isDeclarationFile ? emit(sourceFile) : undefined;
    if (code === undefined) return;
    const imports: { start: number; end: number; specifier: string; target: string }[] = [];
    modules[fileName] = { code, imports };
    for (const imported of ts.preProcessFile(code, /*readImportFiles*/ true, /*detectJavaScriptImports*/ true).importedFiles) {
      const target = ts.resolveModuleName(imported.fileName, fileName, options, host).resolvedModule?.resolvedFileName;
      if (!target) continue;
      visit(target);
      // The reported position is the opening quote's.
      const start = imported.pos + 1;
      if (modules[target]) imports.push({ start, end: start + imported.fileName.length, specifier: imported.fileName, target });
    }
  };
  visit(entry);
  return { entry, format: commonJsRun ? "commonjs" : "esm", modules };
}
