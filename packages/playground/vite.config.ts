import { transform } from "esbuild";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig, type Plugin } from "vite";

const require = createRequire(import.meta.url);
const compilerSource = dirname(dirname(require.resolve("ts-plus-plus/source")));

function compilerSources(): Plugin {
  return {
    name: "tspp:compiler-sources",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!file.startsWith(compilerSource) || !file.endsWith(".ts")) return undefined;
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

export default defineConfig({
  base: "./",
  oxc: { exclude: [/packages[\\/]compiler[\\/]src[\\/]/] },
  plugins: workerPlugins(),
  worker: { format: "es", plugins: workerPlugins },
  build: { chunkSizeWarningLimit: 10000 },
});
