// `dist` holds the compiled TS++ that index.html loads, so the bundled site goes to `site`.
export default {
  build: { outDir: "site", target: "es2022" },
};
