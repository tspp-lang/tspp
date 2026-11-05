import * as ts from "ts-plus-plus/source";
import { parseProjectConfiguration } from "../configuration";
import type { DiagnosticInfo, FeatureDefinition } from "../protocol";

const isSourceFile = (path: string) => /\.(tspp|ts)$/.test(path) && !/\.d\.(tspp|ts)$/.test(path);

function fileSystemEntries(files: ReadonlyMap<string, unknown>, directory: string): ts.FileSystemEntries {
  const prefix = directory === "/" ? "/" : `${directory.replace(/\/$/, "")}/`;
  const childFiles = new Set<string>();
  const childDirectories = new Set<string>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash < 0) childFiles.add(rest);
    else childDirectories.add(rest.slice(0, slash));
  }
  return { files: [...childFiles], directories: [...childDirectories] };
}

export interface ParsedProjectConfiguration {
  readonly options: ts.CompilerOptions;
  readonly rootFileNames: readonly string[];
  readonly diagnostics: readonly DiagnosticInfo[];
}

export function configureProject(
  files: ReadonlyMap<string, { readonly text: string }>,
  definitions: readonly FeatureDefinition[],
  fallbackOptions: () => ts.CompilerOptions,
  toDiagnostic: (diagnostic: ts.Diagnostic) => DiagnosticInfo,
): ParsedProjectConfiguration {
  const configText = files.get("/tsconfig.json")?.text;
  if (configText === undefined) {
    return { options: fallbackOptions(), rootFileNames: [...files.keys()].filter(isSourceFile), diagnostics: [] };
  }
  const compatibility = parseProjectConfiguration(configText, definitions);
  const parsedText = ts.parseConfigFileTextToJson("/tsconfig.json", configText);
  if (parsedText.error) {
    return {
      options: fallbackOptions(),
      rootFileNames: [...files.keys()].filter(isSourceFile),
      diagnostics: compatibility.diagnostics,
    };
  }
  const parsed = ts.parseJsonConfigFileContent(parsedText.config, {
    useCaseSensitiveFileNames: true,
    fileExists: path => files.has(path),
    readFile: path => files.get(path)?.text,
    readDirectory: (rootDir, extensions, excludes, includes, depth) => ts.matchFiles(
      rootDir, extensions, excludes, includes, true, "/", depth,
      directory => fileSystemEntries(files, directory), path => path,
    ),
  }, "/", { allowNonTsExtensions: true, noEmitOnError: false }, "/tsconfig.json", undefined, [{
    extension: ".tspp",
    isMixedContent: false,
    scriptKind: ts.ScriptKind.TS,
  }]);
  return {
    // Outputs and Run are explicit in-memory requests, so `noEmit` only controls the real CLI build and never
    // prevents those Playground views. No files are written to disk here.
    options: { ...parsed.options, allowNonTsExtensions: true, noEmit: false, noEmitOnError: false },
    rootFileNames: parsed.fileNames.filter(isSourceFile),
    diagnostics: [
      ...compatibility.diagnostics,
      ...parsed.errors.map(error => ({ ...toDiagnostic(error), fileName: "/tsconfig.json" })),
    ],
  };
}
