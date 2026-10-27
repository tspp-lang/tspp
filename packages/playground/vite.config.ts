import { build, transform } from "esbuild";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, relative } from "node:path";
import ts from "typescript";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);
// packages/compiler/src, reached through the workspace dependency
const compilerSource = dirname(dirname(require.resolve("ts-plus-plus/source")));
const compilerRoot = dirname(compilerSource);
const examplesRoot = dirname(require.resolve("@tspp/examples/package.json"));
// monaco's exports map hides package.json; its CommonJS entry is min/vs/index.js
const monacoRoot = join(dirname(require.resolve("monaco-editor")), "..", "..");
// the compiler's own solver dependency, so the browser runs the same Z3 as Node
const z3Build = dirname(createRequire(join(compilerRoot, "package.json")).resolve("z3-solver"));

/** Cross-origin isolation, which Z3's threads (SharedArrayBuffer) need. GitHub Pages gets it from coi-serviceworker.js. */
const isolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** JSON with `//` line comments, as used by libs.json and tsppconfig.json. */
function readJsonWithComments(path: string) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\s*\/\/.*$/gm, ""));
}

/** A `virtual:<name>` module whose source `load` computes. */
function virtualModule(name: string, load: (this: { addWatchFile(path: string): void }) => string): Plugin {
  const id = `virtual:${name}`;
  return {
    name: `tspp:${name}`,
    resolveId: source => source === id ? "\0" + id : undefined,
    load(resolved) {
      return resolved === "\0" + id ? load.call(this) : undefined;
    },
  };
}

/**
 * The compiler is consumed as TypeScript source. Vite's default transformer (Oxc)
 * cannot lower `export let` inside namespaces (compiler/debug.ts), so compiler
 * files go through esbuild instead, the same transformer the compiler build uses.
 * The transform API does not read the compiler's tsconfig, so its class-field
 * semantics are passed explicitly: with define semantics every declared field
 * becomes an own `undefined` property, and node cloning (which skips properties
 * the clone already has) then drops values such as SourceFile.parseDiagnostics.
 */
function compilerSourcePlugin(): Plugin {
  return {
    name: "tspp:compiler-source",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!file.startsWith(compilerSource) || !file.endsWith(".ts")) return;
      const result = await transform(code, {
        loader: "ts",
        format: "esm",
        // src/tsconfig-base.json: target es2020, so TypeScript's useDefineForClassFields default is false
        target: "es2020",
        tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
        sourcemap: true,
        sourcefile: file,
      });
      return { code: result.code, map: result.map };
    },
  };
}

/** `virtual:tspp-libs`: the compiler's own lib files, keyed by their built name (lib.es2022.d.ts, lib.dom.d.ts, ...). */
const libsPlugin = () =>
  virtualModule("tspp-libs", function () {
    const libDir = join(compilerSource, "lib");
    const { paths } = readJsonWithComments(join(libDir, "libs.json")) as { paths: Record<string, string> };
    const libs: Record<string, string> = {};
    for (const file of readdirSync(libDir).filter(f => f.endsWith(".d.ts"))) {
      const name = file.slice(0, -".d.ts".length);
      this.addWatchFile(join(libDir, file));
      libs[paths[name] ?? `lib.${name}.d.ts`] = readFileSync(join(libDir, file), "utf8");
    }
    return `export default ${JSON.stringify(libs)};`;
  });

/**
 * `virtual:tspp-package-types`: declarations for importing `ts-plus-plus`,
 * `ts-plus-plus/macros` and `ts-plus-plus/smt`, as files under
 * /node_modules/ts-plus-plus. The compiler sources use isolatedDeclarations, so
 * each file's declaration is emitted on its own without a type check. The worker
 * loads this module only once a file imports the package.
 */
const packageTypesPlugin = () =>
  virtualModule("tspp-package-types", function () {
    const entries = { ".": "typescript/typescript.ts", "./macros": "compiler/macroFacade.ts", "./smt": "compiler/smtLibrary.ts" };
    const toDts = (file: string) => file.replace(/\.ts$/, ".d.ts");
    const files: Record<string, string> = {
      "/node_modules/ts-plus-plus/package.json": JSON.stringify({
        name: "ts-plus-plus",
        exports: Object.fromEntries(Object.entries(entries).map(([path, file]) => [path, { types: `./src/${toDts(file)}` }])),
      }),
    };
    const pending = Object.values(entries);
    const seen = new Set<string>();
    while (pending.length) {
      const file = pending.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const path = join(compilerSource, file);
      this.addWatchFile(path);
      const { outputText } = ts.transpileDeclaration(readFileSync(path, "utf8"), { fileName: file });
      files[`/node_modules/ts-plus-plus/src/${toDts(file)}`] = outputText;
      for (const [, specifier] of outputText.matchAll(/(?:from |import\()"(\.{1,2}\/[^"]+)\.js"/g)) {
        pending.push(posix.join(posix.dirname(file), `${specifier}.ts`));
      }
    }
    return `export default ${JSON.stringify(files)};`;
  });

/**
 * `virtual:tspp-examples`: the projects in packages/examples, each with its
 * tsppconfig.json features and source files (index.tspp and src/), keyed by
 * project-relative path. A package.json comes along when the sources read it.
 */
const examplesPlugin = () =>
  virtualModule("tspp-examples", function () {
    const projects = [];
    for (const project of readdirSync(examplesRoot).filter(name => /^\d\d-/.test(name)).sort()) {
      const projectDir = join(examplesRoot, project);
      const configPath = join(projectDir, "tsppconfig.json");
      if (!existsSync(configPath)) continue;
      const features = readJsonWithComments(configPath).compilerOptions?.tsppFeatures ?? [];
      const sources = [
        ...existsSync(join(projectDir, "index.tspp")) ? ["index.tspp"] : [],
        ...listFiles(join(projectDir, "src")).filter(f => /\.(tspp|ts)$/.test(f) && !/\.d\.(tspp|ts)$/.test(f)).map(f => `src/${f}`),
      ];
      if (!sources.length) continue;
      const files: Record<string, string> = {};
      for (const file of sources) {
        this.addWatchFile(join(projectDir, file));
        files[`/${file}`] = readFileSync(join(projectDir, file), "utf8");
      }
      if (Object.values(files).some(text => text.includes("package.json"))) {
        files["/package.json"] = readFileSync(join(projectDir, "package.json"), "utf8");
      }
      projects.push({ id: project, features: Array.isArray(features) ? features : [features], entry: `/${sources[0]}`, files });
    }
    return `export default ${JSON.stringify(projects)};`;
  });

function listFiles(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry =>
    entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  );
}

/**
 * Z3 for formal contracts: z3-solver's browser build wrapped by src/z3/z3Worker.cjs
 * into one classic worker script, plus its wasm binary. Both are served at
 * z3/ (a dev middleware, or files emitted into the build) and only fetched the
 * first time a contract is checked.
 */
function z3Plugin(): Plugin {
  const workerEntry = join(import.meta.dirname, "src", "z3", "z3Worker.cjs");
  const wasmPath = join(z3Build, "z3-built.wasm");
  let workerScript: Promise<string> | undefined;
  const bundleWorker = () =>
    workerScript ??= build({
      stdin: { contents: readFileSync(workerEntry, "utf8"), resolveDir: z3Build, sourcefile: relative(import.meta.dirname, workerEntry) },
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      target: "es2020",
      legalComments: "none",
      logLevel: "warning",
      plugins: [{
        // z3-built.js requires these only on its Node path, which is dead in a worker
        name: "node-builtin-stubs",
        setup(builder) {
          builder.onResolve({ filter: /^(fs|path|worker_threads)$/ }, args => ({ path: args.path, namespace: "stub" }));
          builder.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};" }));
        },
      }],
    }).then(result => result.outputFiles[0].text);
  return {
    name: "tspp:z3",
    configureServer(server) {
      server.watcher.add(workerEntry);
      server.watcher.on("change", file => {
        if (file === workerEntry) workerScript = undefined;
      });
      server.middlewares.use("/z3/", (request, response, next) => {
        // server.headers do not reach custom middleware, and an isolated page only
        // starts workers whose script also opts into cross-origin embedding
        for (const [name, value] of Object.entries(isolationHeaders)) response.setHeader(name, value);
        if (request.url === "/z3.worker.js") {
          bundleWorker().then(script => {
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

const workerPlugins = () => [compilerSourcePlugin(), libsPlugin(), packageTypesPlugin()];

export default defineConfig({
  // relative base so the site works from the GitHub Pages project subpath
  base: "./",
  resolve: {
    // monaco's exports map only exposes `.js` files; reach its stylesheets by path
    alias: [{ find: /^monaco-editor\/(.*\.css)$/, replacement: `${monacoRoot}/esm/vs/$1` }],
  },
  oxc: { exclude: [/packages[\\/]compiler[\\/]src[\\/]/] },
  plugins: [...workerPlugins(), examplesPlugin(), z3Plugin()],
  worker: { format: "es", plugins: workerPlugins },
  server: { port: 5173, strictPort: true, headers: isolationHeaders },
  preview: { headers: isolationHeaders },
  build: {
    // the language worker carries the whole compiler plus its lib files
    chunkSizeWarningLimit: 10000,
  },
});
