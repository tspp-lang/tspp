// Synchronous Node hooks let CJS and ESM share original module identities and native package resolution.
const fs = require("node:fs");
const path = require("node:path");
const { registerHooks } = require("node:module");
const { fileURLToPath, pathToFileURL } = require("node:url");
const manifest = JSON.parse(fs.readFileSync(process.env.TSPP_RUN_MANIFEST, "utf8"));
delete process.env.TSPP_RUN_MANIFEST;
const files = manifest.files;

function find(filename) {
    if (files[filename]) return filename;
    if (fs.existsSync(filename)) return;
    const stem = filename.replace(/\.(?:[cm]?js|jsx)$/, "");
    const candidates = stem !== filename
        ? [/\.mjs$/.test(filename) ? ".mts" : /\.cjs$/.test(filename) ? ".cts" : ".ts", ".tsx", ".tspp"]
        : [".ts", ".tsx", ".tspp", "/index.ts", "/index.tspp"];
    for (const extension of candidates) if (files[stem + extension]) return stem + extension;
}

registerHooks({
    resolve(specifier, context, nextResolve) {
        if (specifier.startsWith("node:")) return nextResolve(specifier, context);
        const parent = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL) : undefined;
        const mapped = parent && manifest.resolutions[parent]?.[specifier];
        if (mapped && files[mapped]) return { url: pathToFileURL(mapped).href, shortCircuit: true };
        if (specifier.startsWith("file:") || specifier.startsWith(".") || path.isAbsolute(specifier)) {
            const filename = specifier.startsWith("file:") ? fileURLToPath(specifier)
                : path.resolve(parent ? path.dirname(parent) : process.cwd(), specifier);
            const found = find(filename);
            if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
        }
        const resolved = nextResolve(specifier, context);
        if (resolved.url.startsWith("file:")) {
            const found = find(fileURLToPath(resolved.url));
            if (found) return { ...resolved, url: pathToFileURL(found).href };
        }
        return resolved;
    },
    load(url, context, nextLoad) {
        const file = url.startsWith("file:") && files[fileURLToPath(url)];
        return file ? { format: file.format, source: fs.readFileSync(file.output, "utf8"), shortCircuit: true }
            : nextLoad(url, context);
    },
});
