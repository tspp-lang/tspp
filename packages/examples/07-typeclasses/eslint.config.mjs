function projectSource(source) {
  let block = false;
  return source.split(/\r?\n/u).map(line => {
    let code = false;
    for (let index = 0; index < line.length; index++) {
      if (block) {
        if (line[index] === "*" && line[index + 1] === "/") { block = false; index++; }
        continue;
      }
      if (/\s/u.test(line[index])) continue;
      if (line[index] === "/" && line[index + 1] === "/") break;
      if (line[index] === "/" && line[index + 1] === "*") { block = true; index++; continue; }
      code = true;
    }
    return code ? "0;" : "";
  }).join("\n");
}

export default [{
  files: ["src/**/*.tspp"],
  plugins: { tspp: { processors: { lines: { preprocess: source => [projectSource(source)], postprocess: lists => lists.flat(), supportsAutofix: false } } } },
  processor: "tspp/lines",
  rules: { "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }] },
}];

