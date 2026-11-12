import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { formatOperatorSections } from "./formatting";
import { createOperatorSectionSyntax } from "./sections";

export const operatorSectionsPlugin = definePlugin({
    manifest: {
        id: "operator-sections",
        version: "0.0.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Operator sections",
        syntax: {
            keywords: [
                { keyword: "_", position: "primary-expression" },
                { keyword: "_", position: "argument" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const { extensions, diagnostics } = createOperatorSectionSyntax(context.ts);
                const disposers = [...extensions.map(extension => context.compiler.registerSyntaxExtension(extension)), context.compiler.registerDiagnosticProvider(diagnostics)];
                return () => disposers.forEach(dispose => dispose());
            },
        },
        languageService: {
            activate(context) {
                return context.languageService.registerFormattingProvider(formatOperatorSections);
            },
        },
        editor: {
            grammars: ["./editor/operator-sections.tmLanguage.json"],
        },
    },
});

export default operatorSectionsPlugin;
