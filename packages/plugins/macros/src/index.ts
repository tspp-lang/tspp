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
    languageService: {
      activate(context) {
        // The preprocessor blanks all of this for the parser, so only the authored text can tell what is under the cursor.
        return context.languageService.registerQuickInfoProvider(({ sourceText, position }) => {
          for (const { index, 0: head } of sourceText.matchAll(/^[ \t]*(?:(?:export|default|declare|async)\s+)*macro\b(?:\s*\((?:[^()]|\([^()]*\))*\))?/gm)) {
            if (position < index || position > index + head.length) continue;
            for (const word of head.matchAll(/[A-Za-z_$][\w$]*/g)) {
              const start = index + word.index;
              if (position < start || position > start + word[0].length) continue;
              if (word[0] === "macro") return { start, length: word[0].length, display: "(TS++ keyword) macro" };
              if (/^(?:export|default|declare|async)$/.test(word[0])) return undefined;
              return { start, length: word[0].length, display: `(macro option) ${word[0]}` };
            }
          }
          return undefined;
        });
      },
    },
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
