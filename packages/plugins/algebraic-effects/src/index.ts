import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";
import { formatTSPPSyntax } from "@tspp/plugin-sdk/language-service";

import { createEffectChecks } from "./check";
import { createEffectEmit } from "./emit";
import { effectQuickInfo, effectSemanticTokens } from "./quickinfo";
import { createEffectSyntax } from "./syntax";

export const algebraicEffectsPlugin = definePlugin({
    manifest: {
        id: "algebraic-effects",
        version: "0.0.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Algebraic Effects",
        syntax: {
            keywords: [
                { keyword: "effect", position: "declaration" },
                { keyword: "perform", position: "primary-expression" },
                { keyword: "handle", position: "expression" },
                { keyword: "/", position: "function-clause" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const syntax = createEffectSyntax(context.ts);
                const checks = createEffectChecks(context.ts, syntax);
                const emit = createEffectEmit(context.ts, syntax, checks);
                const disposers = [
                    ...syntax.extensions.map(extension => context.compiler.registerSyntaxExtension({ ...extension, restoreCompatibilityDeclaration: emit.restoreCompatibility })),
                    context.compiler.registerDiagnosticProvider(checks.provider),
                    context.compiler.registerSignatureConstraint(checks.constraint),
                    context.compiler.registerTypeExtension(checks.typeExtension),
                    context.compiler.registerProgramRebuilder(emit.rebuilder),
                ];
                return () => disposers.forEach(dispose => dispose());
            },
        },
        languageService: {
            activate(context) {
                context.onDispose(context.languageService.registerFormattingProvider(formatTSPPSyntax));
                context.onDispose(context.languageService.registerSemanticTokensProvider(effectSemanticTokens));
                return context.languageService.registerQuickInfoProvider(effectQuickInfo);
            },
        },
        editor: {
            grammars: ["./editor/algebraic-effects.tmLanguage.json"],
        },
    },
});

export default algebraicEffectsPlugin;
