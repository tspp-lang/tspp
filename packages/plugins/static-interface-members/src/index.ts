import { definePlugin, TSPP_PLUGIN_API_VERSION } from "@tspp/plugin-sdk";

const pluginId = "static-interface-members";

export const staticInterfaceMembersPlugin = definePlugin({
    manifest: {
        id: pluginId,
        version: "0.0.1",
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
                return context.compiler.registerInterfaceMemberContract({
                    modifier: "static",
                    implementationSide: "class-static",
                    thisType: "implementing-instance",
                });
            },
        },
        editor: { grammars: ["./editor/static-interface-members.tmLanguage.json"] },
    },
});

export default staticInterfaceMembersPlugin;
