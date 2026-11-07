import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

import { createStaticSideCheck, isStaticInterfaceMember } from "./check";

const pluginId = "static-interface-members";

export const staticInterfaceMembersPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.0",
        apiVersion: TSPP_PLUGIN_API_VERSION,
        displayName: "Static interface members",
        syntax: {
            keywords: [
                { keyword: "static", position: "interface-member" },
            ],
        },
    },
    facets: {
        compiler: {
            activate(context) {
                const ts = context.ts;
                const disposers = [
                    context.compiler.registerInterfaceMemberBinding({
                        keywords: ["static"],
                        isStaticMember: member => isStaticInterfaceMember(ts, member),
                    }),
                    context.compiler.registerDiagnosticProvider(createStaticSideCheck(ts)),
                    // Static interface members have no TypeScript spelling, so the compatible `.d.ts` leaves them out.
                    // The upstream parser reads them; this extension only restores declaration output.
                    context.compiler.registerSyntaxExtension({
                        position: "declaration",
                        startTokens: [],
                        isStart: () => false,
                        parse: () => {
                            throw new Error("Static interface members have no syntax of their own.");
                        },
                        restoreCompatibilityDeclaration: node => isStaticInterfaceMember(ts, node) ? "" : undefined,
                    }),
                ];
                return () => disposers.forEach(dispose => dispose());
            },
        },
        editor: { grammars: ["./editor/static-interface-members.tmLanguage.json"] },
    },
});

export default staticInterfaceMembersPlugin;
