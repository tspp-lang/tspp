import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { createMacroPreprocessor, createMacroRebuilder, getMacroExpansions } from "./rebuilder";

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
    editor: {
      grammars: ["./editor/macros.tmLanguage.json"],
      overlayViews: [{
        id: "macros/expansion",
        commandId: "tspp.showExpandedSource",
        title: "TS++: Show Macro Expansion",
        label: "Macro expansion",
        progressTitle: "TS++: Generating macro expansion…",
        emptyMessage: "This file contains no compile-time macro invocations.",
        getOverlays: (program, fileName) => getMacroExpansions(program, fileName).map(expansion => ({
          start: expansion.start,
          length: expansion.length,
          text: expansion.text,
          hoverTitle: `TS++ macro expansion: \`${expansion.macroName}\``,
          hoverWhenEmpty: "This validation-only macro emits no statements.",
        })),
      }],
    },
  },
});

export default macrosPlugin;
export { macroApiVersion } from "./sdk";
export type * from "./sdk";
export type { MacroCompilerHost } from "./expand";
export { expandInThisThread, getMacroExpansions } from "./rebuilder";
