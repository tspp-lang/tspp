import { execFileSync } from "node:child_process";
import { build, transform } from "esbuild";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const compilerSource = resolve(import.meta.dirname, "../compiler/src");
const compilerEntry = join(compilerSource, "typescript/typescript.ts");
const diagnosticMessages = join(compilerSource, "compiler/diagnosticMessages.json");
const normalizedCompilerSource = compilerSource.replaceAll("\\", "/");
const z3Build = dirname(require.resolve("z3-solver"));
const examplesRoot = resolve(import.meta.dirname, "../examples");
const monacoRoot = join(dirname(require.resolve("monaco-editor")), "..", "..");
const browserPackages = [
  "@tspp/plugin-sdk",
  "@tspp/plugin-sdk/compiler",
  "@tspp/plugin-sdk/editor",
  "@tspp/plugin-sdk/host",
  "@tspp/plugin-sdk/language-service",
  "@tspp/plugin-dependent-types",
  "@tspp/plugin-formal-verification",
  "@tspp/plugin-higher-kinded-types",
  "@tspp/plugin-macros",
  "@tspp/plugin-modern-syntax",
  "@tspp/plugin-nominal-types",
  "@tspp/plugin-operator-sections",
  "@tspp/plugin-static-interface-members",
  "@tspp/plugin-type-computation",
];
const declarationPackages = [...new Set(browserPackages.filter(name => name.startsWith("@tspp/")).map(name =>
  name.split("/").slice(0, 2).join("/")
))];
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/**
 * Regenerates diagnosticInformationMap.generated.ts, which is not tracked: a copy left
 * from an older checkout lacks newer messages, and the compiler then fails on them at
 * runtime. The generator only writes files whose content changed.
 */
function generateDiagnostics() {
  execFileSync(process.execPath, [join(compilerSource, "../scripts/processDiagnosticMessages.mjs"), diagnosticMessages], { stdio: "ignore" });
}

function compilerSources(): Plugin {
  return {
    name: "tspp:compiler-sources",
    enforce: "pre",
    buildStart: generateDiagnostics,
    configureServer(server) {
      server.watcher.add(diagnosticMessages);
      server.watcher.on("change", file => {
        if (resolve(file) === diagnosticMessages) generateDiagnostics();
      });
    },
    async transform(code, id) {
      const file = id.split("?")[0].replace(/^\/@fs\//, "").replaceAll("\\", "/");
      if (!file.startsWith(normalizedCompilerSource) || !file.endsWith(".ts")) return undefined;
      const result = await transform(code, {
        loader: "ts",
        format: "esm",
        target: "es2020",
        tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
        sourcemap: true,
        sourcefile: file,
      });
      return { code: result.code, map: result.map };
    },
  };
}

function compilerLibraries(): Plugin {
  const id = "virtual:tspp-libs";
  return {
    name: "tspp:compiler-libraries",
    resolveId(source) { return source === id ? `\0${id}` : undefined; },
    load(source) {
      if (source !== `\0${id}`) return undefined;
      const directory = join(compilerSource, "lib");
      const pathsFile = readFileSync(join(directory, "libs.json"), "utf8").replace(/^\s*\/\/.*$/gm, "");
      const paths = (JSON.parse(pathsFile) as { paths: Record<string, string> }).paths;
      const libraries: Record<string, string> = {};
      for (const file of readdirSync(directory).filter(name => name.endsWith(".d.ts"))) {
        const shortName = file.slice(0, -5);
        libraries[paths[shortName] ?? `lib.${shortName}.d.ts`] = readFileSync(join(directory, file), "utf8");
      }
      return `export default ${JSON.stringify(libraries)};`;
    },
  };
}

function packageTypes(): Plugin {
  const id = "virtual:tspp-package-types";
  return {
    name: "tspp:package-types",
    resolveId(source) { return source === id ? `\0${id}` : undefined; },
    load(source) {
      if (source !== `\0${id}`) return undefined;
      const files: Record<string, string> = {};
      for (const packageName of declarationPackages) {
        const root = dirname(dirname(require.resolve(packageName)));
        const packagePath = join(root, "package.json");
        files[`/node_modules/${packageName}/package.json`] = readFileSync(packagePath, "utf8");
        for (const file of listFiles(join(root, "dist")).filter(file => file.endsWith(".d.ts"))) {
          files[`/node_modules/${packageName}/dist/${file}`] = readFileSync(join(root, "dist", file), "utf8");
        }
      }
      const examplePackages = readdirSync(examplesRoot).filter(name => /^\d\d-/.test(name)).flatMap(directory => {
        const root = join(examplesRoot, directory);
        const manifestPath = join(root, "package.json");
        if (!existsSync(manifestPath)) return [];
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          tsppTypes?: string;
          types?: string;
          exports?: Record<string, unknown>;
        };
        return manifest.name ? [{ root, manifest }] : [];
      });
      const exampleNames = new Set(examplePackages.map(({ manifest }) => manifest.name!));
      const importedExamples = new Set(examplePackages.flatMap(({ manifest }) =>
        Object.keys(manifest.dependencies ?? {}).filter(name => exampleNames.has(name))
      ));
      for (const { root, manifest } of examplePackages.filter(({ manifest }) => importedExamples.has(manifest.name!))) {
        const declaredEntry = manifest.tsppTypes ?? manifest.types;
        const match = declaredEntry?.match(/^\.\/dist\/(.+)\.d\.(?:tspp|ts)$/);
        if (!match) throw new Error(`${manifest.name} must map its declaration entry to a source file for the playground.`);
        const sourceEntry = `./src/${match[1]}.tspp`;
        const browserManifest = {
          ...manifest,
          tsppTypes: sourceEntry,
          types: sourceEntry,
          exports: { ".": { "tspp-types": sourceEntry, types: sourceEntry, default: sourceEntry } },
        };
        files[`/node_modules/${manifest.name}/package.json`] = JSON.stringify(browserManifest);
        for (const file of listFiles(join(root, "src")).filter(file => /\.(tspp|ts|json)$/.test(file))) {
          files[`/node_modules/${manifest.name}/src/${file}`] = readFileSync(join(root, "src", file), "utf8");
        }
      }
      return `export default ${JSON.stringify(files)};`;
    },
  };
}

function editorKeywords(): Plugin {
  const id = "virtual:tspp-editor-keywords";
  return {
    name: "tspp:editor-keywords",
    resolveId(source) { return source === id ? `\0${id}` : undefined; },
    load(source) {
      if (source !== `\0${id}`) return undefined;
      const keywords = new Set<string>();
      for (const packageName of declarationPackages) {
        const loaded = require(packageName) as { default?: unknown };
        const plugin = (loaded.default ?? loaded) as { facets?: { editor?: { keywords?: readonly string[] } } };
        plugin.facets?.editor?.keywords?.forEach(keyword => keywords.add(keyword));
      }
      return `export default ${JSON.stringify([...keywords])};`;
    },
  };
}

const workerPlugins = () => [compilerSources(), compilerLibraries(), packageTypes(), editorKeywords()];

function listFiles(directory: string, prefix = ""): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)).flatMap(entry =>
    entry.isDirectory()
      ? listFiles(join(directory, entry.name), `${prefix}${entry.name}/`)
      : [`${prefix}${entry.name}`]
  );
}

function exampleFeature(packageName: string): string | undefined {
  const names: Record<string, string> = {
    "@tspp/plugin-dependent-types": "type-system/dependent-types",
    "@tspp/plugin-formal-verification": "formal-verification/z3",
  };
  return names[packageName] ?? packageName.match(/^@tspp\/plugin-(.+)$/)?.[1];
}

function examplesPlugin(): Plugin {
  const id = "virtual:tspp-examples";
  return {
    name: "tspp:examples",
    resolveId(source) { return source === id ? `\0${id}` : undefined; },
    load(source) {
      if (source !== `\0${id}`) return undefined;
      const entries = readdirSync(examplesRoot).filter(name => /^\d\d-/.test(name)).sort().flatMap(project => {
        const directory = join(examplesRoot, project);
        const configPath = join(directory, "tsconfig.json");
        if (!existsSync(configPath)) return [];
        const config = JSON.parse(readFileSync(configPath, "utf8")) as {
          compilerOptions?: { plugins?: { name?: string; tspp?: boolean }[] };
        };
        const features = (config.compilerOptions?.plugins ?? [])
          .filter(plugin => plugin.tspp && plugin.name)
          .map(plugin => exampleFeature(plugin.name!))
          .filter((feature): feature is string => !!feature);
        const sourceRoot = join(directory, "src");
        const sources = listFiles(sourceRoot).filter(file => /\.(tspp|ts)$/.test(file) && !/\.d\.(tspp|ts)$/.test(file));
        if (!sources.length) return [];
        const resources = listFiles(sourceRoot).filter(file => file.endsWith(".json"));
        const files = Object.fromEntries([
          ["/package.json", readFileSync(join(directory, "package.json"), "utf8")],
          ...sources.map(file => [`/src/${file}`, readFileSync(join(sourceRoot, file), "utf8")]),
          ...resources.map(file => [`/src/${file}`, readFileSync(join(sourceRoot, file), "utf8")]),
        ]);
        return [{
          id: project,
          features,
          entry: `/src/${sources[0]}`,
          files,
        }];
      });
      return `export default ${JSON.stringify(entries)};`;
    },
  };
}

function z3Runtime(): Plugin {
  const workerEntry = join(import.meta.dirname, "src", "z3", "z3Worker.cjs");
  const wasmPath = join(z3Build, "z3-built.wasm");
  let workerScript: Promise<string> | undefined;
  const bundleWorker = () => workerScript ??= build({
    stdin: {
      contents: readFileSync(workerEntry, "utf8"),
      resolveDir: z3Build,
      sourcefile: relative(import.meta.dirname, workerEntry),
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2020",
    legalComments: "none",
    logLevel: "warning",
    plugins: [{
      name: "node-builtin-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^(fs|path|worker_threads)$/ }, args => ({ path: args.path, namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};" }));
      },
    }],
  }).then(result => result.outputFiles[0].text);
  return {
    name: "tspp:z3-runtime",
    configureServer(server) {
      server.watcher.add(workerEntry);
      server.watcher.on("change", file => { if (file === workerEntry) workerScript = undefined; });
      server.middlewares.use("/z3/", (request, response, next) => {
        for (const [name, value] of Object.entries(isolationHeaders)) response.setHeader(name, value);
        if (request.url === "/z3.worker.js") {
          void bundleWorker().then(script => {
            response.setHeader("Content-Type", "text/javascript");
            response.end(script);
          }, next);
        }
        else if (request.url === "/z3-built.wasm") {
          response.setHeader("Content-Type", "application/wasm");
          response.setHeader("Content-Length", statSync(wasmPath).size);
          response.end(readFileSync(wasmPath));
        }
        else next();
      });
    },
    async generateBundle() {
      this.emitFile({ type: "asset", fileName: "z3/z3.worker.js", source: await bundleWorker() });
      this.emitFile({ type: "asset", fileName: "z3/z3-built.wasm", source: readFileSync(wasmPath) });
    },
  };
}

export default defineConfig({
  base: "./",
  resolve: { alias: [
    { find: "ts-plus-plus/source", replacement: compilerEntry },
    { find: /^monaco-editor\/(.*\.css)$/, replacement: `${monacoRoot}/esm/vs/$1` },
  ] },
  optimizeDeps: { include: browserPackages },
  oxc: { exclude: [/packages[\\/]compiler[\\/]src[\\/]/] },
  plugins: [...workerPlugins(), examplesPlugin(), z3Runtime()],
  worker: { format: "es", plugins: workerPlugins },
  server: { port: 5173, strictPort: true, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { chunkSizeWarningLimit: 10000 },
});
