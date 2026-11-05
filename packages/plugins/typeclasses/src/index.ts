import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { createTypeclassEmit } from "./emit";
import { createTypeclassEvidence } from "./evidence";
import { typeclassQuickInfo, typeclassSemanticTokens } from "./quickinfo";
import { createTypeclassSyntax } from "./syntax";

export const typeclassesPlugin = definePlugin({
    manifest: {
        id: "typeclasses",
        version: "0.0.1",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Typeclasses",
        syntax: {
            keywords: [
                { keyword: "typeclass", position: "declaration" },
                { keyword: "impl", position: "declaration" },
                { keyword: "where", position: "function-clause" },
                { keyword: "where", position: "header-clause" },
                { keyword: "where", position: "type-alias-annotation" },
                { keyword: "@", position: "argument" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const syntax = createTypeclassSyntax(context.ts);
                const evidence = createTypeclassEvidence(context.ts, syntax);
                const emit = createTypeclassEmit(context.ts, syntax, evidence);
                const disposers = [
                    ...syntax.extensions.map(extension => context.compiler.registerSyntaxExtension({ ...extension, restoreCompatibilityDeclaration: emit.restoreCompatibility })),
                    context.compiler.registerDiagnosticProvider(evidence.provider),
                    context.compiler.registerSignatureConstraint(evidence.constraint),
                    context.compiler.registerProgramRebuilder(emit.rebuilder),
                ];
                return () => disposers.forEach(dispose => dispose());
            },
        },
        languageService: {
            activate(context) {
                context.onDispose(context.languageService.registerSemanticTokensProvider(typeclassSemanticTokens));
                return context.languageService.registerQuickInfoProvider(typeclassQuickInfo);
            },
        },
        editor: {
            grammars: ["./editor/typeclasses.tmLanguage.json"],
        },
    },
});

export default typeclassesPlugin;
