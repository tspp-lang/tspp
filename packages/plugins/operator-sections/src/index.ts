import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { createOperatorSectionRewriter } from "./sections";

export const operatorSectionsPlugin = definePlugin({
    manifest: {
        id: "operator-sections",
        version: "0.1.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Operator sections",
        syntax: {
            keywords: [
                { keyword: "_", position: "expression" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                return context.compiler.registerExpressionRewriter(createOperatorSectionRewriter(context.ts));
            },
        },
        editor: {
            grammars: ["./editor/operator-sections.tmLanguage.json"],
        },
    },
});

export default operatorSectionsPlugin;
