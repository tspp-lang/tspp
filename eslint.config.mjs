import globals from "globals";
import tseslint from "typescript-eslint";

const maxLines = [
  "error",
  {
    max: 500,
    skipBlankLines: true,
    skipComments: true,
  },
];

function projectTsppForLineCounting(source) {
  let inBlockComment = false;

  return source
    .split(/\r?\n/u)
    .map((line) => {
      let hasCode = false;

      for (let index = 0; index < line.length; index++) {
        if (inBlockComment) {
          if (line[index] === "*" && line[index + 1] === "/") {
            inBlockComment = false;
            index++;
          }
          continue;
        }

        if (/\s/u.test(line[index])) continue;
        if (line[index] === "/" && line[index + 1] === "/") break;
        if (line[index] === "/" && line[index + 1] === "*") {
          inBlockComment = true;
          index++;
          continue;
        }

        hasCode = true;
      }

      return hasCode ? "0;" : "";
    })
    .join("\n");
}

const tsppLineCounter = {
  meta: {
    name: "tspp-line-counter",
    version: "1.0.0",
  },
  preprocess(source) {
    return [projectTsppForLineCounting(source)];
  },
  postprocess(messageLists) {
    return messageLists.flat();
  },
  supportsAutofix: false,
};

export default [
  {
    ignores: [
      "packages/compiler/**",
      "packages/language-server/**",
      "**/node_modules/**",
      "**/dist/**",
      "**/lib/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["packages/**/*.{js,cjs,mjs,ts,tsx,cts,mts}"],
    linterOptions: {
      reportUnusedDisableDirectives: false,
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      globals: globals.node,
    },
    rules: {
      "max-lines": maxLines,
    },
  },
  {
    files: ["packages/examples/**/*.tspp"],
    plugins: {
      tspp: {
        processors: {
          lines: tsppLineCounter,
        },
      },
    },
    processor: "tspp/lines",
    rules: {
      "max-lines": maxLines,
    },
  },
];
