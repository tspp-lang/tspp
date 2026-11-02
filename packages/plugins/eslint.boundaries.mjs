// Plugins couple only to TypeScript and the SDK (docs/core-restoration-plan.md, "插件间关系"). A plugin reaches a
// dependency's API through `context.dependencies.get` and may import the provider's types, never its runtime values.
export const pluginBoundaryRules = {
  "@typescript-eslint/no-restricted-imports": ["error", {
    patterns: [
      {
        group: ["@tspp/plugin-*", "!@tspp/plugin-sdk", "!@tspp/plugin-sdk/*"],
        allowTypeImports: true,
        message: "Use context.dependencies.get for another plugin's API; only `import type` from its ./api subpath.",
      },
      {
        group: ["typescript", "typescript-upstream"],
        allowTypeImports: true,
        message: "Use the host compiler's API from context.ts; only `import type` from TypeScript packages.",
      },
      {
        group: ["../../*/src/*", "../../*/dist/*"],
        message: "Plugins must not reach into another plugin's sources.",
      },
    ],
  }],
};
