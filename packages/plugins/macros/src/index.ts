import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { createMacroPreprocessor, createMacroRebuilder } from "./rebuilder";

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
      ],
    },
  },
  facets: {
    compiler: {
      activate(context) {
        const disposePreprocessor = context.compiler.registerSourcePreprocessor(createMacroPreprocessor(context.ts));
        const disposeRebuilder = context.compiler.registerProgramRebuilder(createMacroRebuilder(context.ts));
        return () => {
          disposeRebuilder();
          disposePreprocessor();
        };
      },
    },
    editor: { grammars: ["./editor/macros.tmLanguage.json"] },
  },
});

export default macrosPlugin;
export { macroApiVersion } from "./sdk";
export type * from "./sdk";
export type { MacroCompilerHost } from "./expand";
export { expandInThisThread, getMacroExpansions } from "./rebuilder";
