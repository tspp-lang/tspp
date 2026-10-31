import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

export const macrosPlugin = definePlugin({
  manifest: {
    id: "macros",
    version: "0.0.1",
    apiVersion: TSPP_PLUGIN_API_VERSION,
    displayName: "Compile-time macros",
  },
  facets: {
    compiler: {
      activate(context) {
        return context.compiler.registerCompileTimeMacros();
      },
    },
    editor: { grammars: ["./editor/macros.tmLanguage.json"] },
  },
});

export default macrosPlugin;
export { macroApiVersion } from "./sdk";
export type * from "./sdk";
