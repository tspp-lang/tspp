import * as monaco from "./monaco";

export const jsoncLanguageId = "jsonc";

/** Lightweight JSON-with-comments highlighting without pulling in Monaco's separate JSON worker. */
export function registerJsoncLanguage(): void {
  monaco.languages.register({ id: jsoncLanguageId, extensions: [".json", ".jsonc"] });
  monaco.languages.setLanguageConfiguration(jsoncLanguageId, {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: '"', close: '"' },
    ],
  });
  monaco.languages.setMonarchTokensProvider(jsoncLanguageId, {
    tokenizer: {
      root: [
        [/\s+/, "white"],
        [/\/\/.*$/, "comment"],
        [/\/\*/, "comment", "@comment"],
        [/"(?:\\.|[^"\\])*"(?=\s*:)/, "key"],
        [/"(?:\\.|[^"\\])*"/, "string"],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
        [/\b(?:true|false|null)\b/, "keyword"],
        [/[{}[\],:]/, "delimiter"],
      ],
      comment: [
        [/[^/*]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[/*]/, "comment"],
      ],
    },
  });
}
