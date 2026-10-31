import { build, transform } from "esbuild";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const compilerSource = dirname(dirname(require.resolve("ts-plus-plus/source")));
const normalizedCompilerSource = compilerSource.replaceAll("\\", "/");
const z3Build = dirname(require.resolve("z3-solver"));
const browserPackages = [
  "@tspp/plugin-sdk",
  "@tspp/plugin-sdk/compiler",
  "@tspp/plugin-sdk/host",
  "@tspp/plugin-sdk/language-service",
  "@tspp/plugin-dependent-types",
  "@tspp/plugin-formal-verification",
  "@tspp/plugin-higher-kinded-types",
  "@tspp/plugin-macros",
  "@tspp/plugin-modern-syntax",
  "@tspp/plugin-nominal-types",
  "@tspp/plugin-static-interface-members",
  "@tspp/plugin-type-computation",
];
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function compilerSources(): Plugin {
  return {
    name: "tspp:compiler-sources",
    enforce: "pre",
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

const workerPlugins = () => [compilerSources(), compilerLibraries()];

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
  optimizeDeps: { include: browserPackages },
  oxc: { exclude: [/packages[\\/]compiler[\\/]src[\\/]/] },
  plugins: [...workerPlugins(), z3Runtime()],
  worker: { format: "es", plugins: workerPlugins },
  server: { port: 5173, strictPort: true, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: { chunkSizeWarningLimit: 10000 },
});
