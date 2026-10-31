import tseslint from "typescript-eslint";

function projectSourceForLineCounting(source) {
  let inBlockComment = false;
  return source.split(/\r?\n/u).map((line) => {
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
  }).join("\n");
}

const tsppLineCounter = {
  meta: { name: "tspp-line-counter", version: "1.0.0" },
  preprocess(source) {
    return [projectSourceForLineCounting(source)];
  },
  postprocess(messageLists) {
    return messageLists.flat();
  },
  supportsAutofix: false,
};

const maxLines = ["error", { max: 500, skipBlankLines: true, skipComments: true }];

export default [
  {
    files: ["src/**/*.tspp"],
    plugins: { tspp: { processors: { lines: tsppLineCounter } } },
    processor: "tspp/lines",
    rules: { "max-lines": maxLines },
  },
  {
    files: ["src/**/*.ts", "consumer/src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    rules: { "max-lines": maxLines },
  },
];
