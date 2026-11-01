import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

export const macrosPlugin = definePlugin({
  manifest: {
    id: "macros",
    version: "0.0.1",
    apiVersion: TSPP_PLUGIN_API_VERSION,
    displayName: "Compile-time macros",
    syntax: {
      keywords: [
        { keyword: "macro", position: "declaration" },
        { keyword: "macro", position: "statement" },
        { keyword: "with", position: "function-clause" },
      ],
    },
  },
  facets: {
    compiler: {
      activate(context) {
        return context.compiler.registerCompileTimeMacros();
      },
    },
    editor: { keywords: ["macro", "with"], grammars: ["./editor/macros.tmLanguage.json"] },
  },
});

export default macrosPlugin;
export { macroApiVersion } from "./sdk";
export type * from "./sdk";
