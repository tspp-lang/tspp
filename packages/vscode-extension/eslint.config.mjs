import globals from "globals";

export default [
  {
    files: ["extension.js", "configuration*.js", "scripts/**/*.js", "test/**/*.cjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "max-lines": [
        "error",
        {
          max: 500,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
    },
  },
];
