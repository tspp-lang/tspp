import globals from "globals";
import tseslint from "typescript-eslint";

export default [{
  files: ["src/**/*.ts", "vite.config.ts", "scripts/**/*.mjs"],
  languageOptions: { parser: tseslint.parser, globals: { ...globals.browser, ...globals.node } },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: { "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }] },
}];
