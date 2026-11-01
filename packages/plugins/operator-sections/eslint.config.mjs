import globals from "globals";
import tseslint from "typescript-eslint";

export default [{
  files: ["src/**/*.{ts,tsx,cts,mts}"],
  languageOptions: { parser: tseslint.parser, globals: globals.node },
  plugins: { "@typescript-eslint": tseslint.plugin },
  rules: {
    "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
  },
}];
