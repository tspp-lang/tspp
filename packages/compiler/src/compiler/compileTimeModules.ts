import {
  CompilerHost,
  createProgram,
  createSourceFile,
  CustomTransformers,
  emptyArray,
  Extension,
  fileExtensionIs,
  forEachChildRecursively,
  getDirectoryPath,
  getScriptKindFromFileName,
  getSourceFileOfNode,
  isIdentifier,
  isImportDeclaration,
  isStatement,
  ModuleKind,
  Node,
  Program,
  resolveModuleName,
  SourceFile,
  Statement,
} from "./_namespaces/ts.js";
import * as macroFacade from "./macroFacade.js";
import * as smtLibrary from "./smtLibrary.js";

/**
 * Runs user modules at compile time: macro implementations and logic
 * libraries. A module is emitted as CommonJS from a dedicated build program
 * and executed through `CompilerHost.evaluateMacroModule` (or Node by
 * default). When roots are given, only those statements and the local
 * declarations they reference are emitted, so ordinary top-level code in the
 * same file does not run at compile time.
 *
 * The compiler serves its own public facades (`ts-plus-plus/macros` and
 * `ts-plus-plus/smt`) to every module it runs, so compile-time code always
 * talks to the compiler version that is running it, in Node and in a browser
 * host alike.
 *
 * @internal
 */
export interface CompileTimeModuleLoader {
  /**
   * Evaluates `sourceFile`. With `roots`, only they and their local
   * dependencies run; `localNames` are then exposed on `exports.__tsppLocals`
   * even when they are not exported.
   */
  evaluate(sourceFile: SourceFile, roots?: readonly Statement[], localNames?: readonly string[]): Record<string, unknown>;
  /** Runs CommonJS source in the host with the loader's module resolution. */
  run(javascript: string, fileName: string, requireLocal: (specifier: string) => unknown, moduleRecord: { exports: Record<string, unknown>; }): void;
}

/** Specifiers the compiler answers itself, before the host or Node module loader. */
function getCompilerProvidedModule(specifier: string): unknown {
  switch (specifier) {
    case "ts-plus-plus/macros":
      return macroFacade;
    case "ts-plus-plus/smt":
      return smtLibrary;
    default:
      return undefined;
  }
}

/** Default CompilerHost.evaluateMacroModule: runs the CommonJS module in this
 *  process and serves non-local specifiers through Node's module loader. */
function evaluateModuleInNode(javascript: string, fileName: string, requireLocal: (specifier: string) => unknown, moduleRecord: { exports: Record<string, unknown>; }) {
  let nativeRequire: NodeRequire | undefined;
  const moduleRequire = (specifier: string) => {
    const local = requireLocal(specifier);
    if (local !== undefined) return local;
    nativeRequire ??= (require("module") as typeof import("module")).createRequire(fileName);
    return nativeRequire(specifier);
  };
  // eslint-disable-next-line no-new-func -- The module is compiler-generated JavaScript and requires a CommonJS wrapper.
  const execute = new Function("require", "exports", "module", "__filename", "__dirname", javascript);
  execute(moduleRequire, moduleRecord.exports, moduleRecord, fileName, getDirectoryPath(fileName));
}

/** @internal */
export function createCompileTimeModuleLoader(program: Program, host: CompilerHost): CompileTimeModuleLoader {
  const checker = program.getTypeChecker();
  const moduleCache = new Map<string, Record<string, unknown>>();
  let buildProgram: Program | undefined;
  let buildHost: CompilerHost | undefined;

  function getBuildProgram() {
    if (!buildProgram) {
      buildHost = Object.create(host) as CompilerHost;
      // The build program only emits JavaScript. Without these hooks it never
      // schedules formal verification, which would evaluate logic modules and
      // create another build program, recursively.
      buildHost.scheduleAsyncFormalVerification = undefined;
      buildHost.isAsyncFormalVerificationPending = undefined;
      buildHost.getResolvedAsyncFormalVerification = undefined;
      // A server host owns watched resolution entries for its outer project.
      // Reusing those hooks in this nested emit-only program corrupts their
      // file/watcher counts when the nested program releases its resolutions.
      buildHost.resolveModuleNameLiterals = undefined;
      buildHost.resolveModuleNames = undefined;
      buildHost.resolveTypeReferenceDirectiveReferences = undefined;
      buildHost.resolveTypeReferenceDirectives = undefined;
      buildHost.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
        const source = host.getSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
        if (!source || source.isDeclarationFile || !fileExtensionIs(fileName, Extension.Tspp)) return source;
        return createSourceFile(fileName, source.text, languageVersionOrOptions, /*setParentNodes*/ true, getScriptKindFromFileName(fileName));
      };
      buildProgram = createProgram({
        rootNames: program.getRootFileNames(),
        options: {
          ...program.getCompilerOptions(),
          declaration: false,
          declarationMap: false,
          emitDeclarationOnly: false,
          incremental: false,
          composite: false,
          module: ModuleKind.CommonJS,
          noEmit: false,
          noEmitOnError: false,
          sourceMap: false,
        },
        host: buildHost,
      });
    }
    return buildProgram;
  }

  function run(javascript: string, fileName: string, requireLocal: (specifier: string) => unknown, moduleRecord: { exports: Record<string, unknown>; }) {
    const withCompilerModules = (specifier: string) => getCompilerProvidedModule(specifier) ?? requireLocal(specifier);
    (host.evaluateMacroModule ?? evaluateModuleInNode)(javascript, fileName, withCompilerModules, moduleRecord);
  }

  function evaluate(sourceFile: SourceFile, roots?: readonly Statement[], localNames: readonly string[] = emptyArray): Record<string, unknown> {
    const cacheKey = roots
      ? `roots:${sourceFile.fileName}:${roots.map(root => `${root.pos}-${root.end}`).join(",")}:${localNames.join(",")}`
      : `module:${sourceFile.fileName}`;
    const cached = moduleCache.get(cacheKey);
    if (cached) return cached;

    const build = getBuildProgram();
    const buildSource = build.getSourceFile(sourceFile.fileName);
    if (!buildSource) throw new Error(`Compile-time module '${sourceFile.fileName}' is not part of the program.`);
    let javascript = "";
    const retainedStatements = roots ? getDependencyStatements(sourceFile, roots) : undefined;
    const transformers: CustomTransformers | undefined = retainedStatements && {
      before: [context => emittedSource => {
        if (emittedSource.fileName !== buildSource.fileName) return emittedSource;
        const statements = emittedSource.statements.filter(statement => retainedStatements.has(`${statement.pos}:${statement.end}`));
        return context.factory.updateSourceFile(emittedSource, statements);
      }],
    };
    build.emit(
      buildSource,
      (fileName, text) => {
        if (/\.(?:c|m)?js$/i.test(fileName)) javascript = text;
      },
      /*cancellationToken*/ undefined,
      /*emitOnlyDtsFiles*/ false,
      transformers,
    );
    if (!javascript) throw new Error(`Compile-time module '${sourceFile.fileName}' did not produce JavaScript.`);
    if (localNames.length) {
      javascript += `\nmodule.exports.__tsppLocals = {${localNames.map(name => `${JSON.stringify(name)}: typeof ${name} === "undefined" ? undefined : ${name}`).join(",")}};`;
    }

    const moduleRecord: { exports: Record<string, unknown>; } = { exports: {} };
    moduleCache.set(cacheKey, moduleRecord.exports);
    const requireLocal = (specifier: string) => {
      const hostModule = buildHost!.resolveMacroModule?.(specifier, sourceFile.fileName);
      if (hostModule !== undefined) return hostModule;
      const resolved = resolveModuleName(specifier, sourceFile.fileName, build.getCompilerOptions(), buildHost!).resolvedModule;
      const dependency = resolved && build.getSourceFile(resolved.resolvedFileName);
      if (dependency && !dependency.isDeclarationFile && !fileExtensionIs(dependency.fileName, Extension.Json)) {
        return evaluate(dependency);
      }
      return undefined;
    };
    try {
      run(javascript, sourceFile.fileName, requireLocal, moduleRecord);
    }
    catch (e) {
      moduleCache.delete(cacheKey);
      throw e;
    }
    moduleCache.set(cacheKey, moduleRecord.exports);
    return moduleRecord.exports;
  }

  /** The root statements, every same-file statement they reference, and side-effect imports. */
  function getDependencyStatements(sourceFile: SourceFile, roots: readonly Statement[]): Set<string> {
    const statements = new Set<Statement>();
    const pending: Statement[] = [];
    for (const root of roots) add(root);
    for (const statement of sourceFile.statements) {
      if (isImportDeclaration(statement) && !statement.importClause) add(statement);
    }
    while (pending.length) {
      const statement = pending.pop()!;
      forEachChildRecursively(statement, node => {
        if (!isIdentifier(node)) return undefined;
        const symbol = checker.getSymbolAtLocation(node);
        for (const declaration of symbol?.declarations ?? emptyArray) {
          if (getSourceFileOfNode(declaration) !== sourceFile) continue;
          let current: Node = declaration;
          while (current.parent && current.parent !== sourceFile) current = current.parent;
          if (current.parent === sourceFile && isStatement(current)) add(current);
        }
        return undefined;
      });
    }
    return new Set([...statements].map(statement => `${statement.pos}:${statement.end}`));

    function add(statement: Statement) {
      if (statements.has(statement)) return;
      statements.add(statement);
      pending.push(statement);
    }
  }

  return { evaluate, run };
}
