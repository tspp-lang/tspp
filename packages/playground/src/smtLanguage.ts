import * as monaco from "./monaco";

export const smtLanguageId = "smt2";

/** Lightweight SMT-LIB2 highlighting for solver artifacts; parsing remains Z3's job. */
export function registerSmtLanguage(): void {
  monaco.languages.register({ id: smtLanguageId, aliases: ["SMT-LIB2", "SMT2"], extensions: [".smt2"] });
  monaco.languages.setMonarchTokensProvider(smtLanguageId, {
    defaultToken: "",
    tokenPostfix: ".smt2",
    brackets: [
      { open: "(", close: ")", token: "delimiter.parenthesis" },
    ],
    keywords: [
      "assert", "check-sat", "declare-const", "declare-fun", "define-fun", "define-fun-rec",
      "exists", "forall", "get-model", "get-value", "let", "set-logic", "set-option",
    ],
    operators: ["and", "distinct", "div", "false", "iff", "implies", "ite", "mod", "not", "or", "rem", "true", "xor"],
    sorts: ["Array", "BitVec", "Bool", "Int", "Real", "String"],
    tokenizer: {
      root: [
        [/;.*$/, "comment"],
        [/"(?:""|[^"])*"/, "string"],
        [/\|(?:\\.|[^|])*\|/, "identifier.quote"],
        [/#(?:x[0-9a-fA-F]+|b[01]+)/, "number"],
        [/[+-]?(?:\d+(?:\.\d+)?|\.\d+)/, "number"],
        [/[A-Za-z_~!@$%^&*+=<>.?/-][\w~!@$%^&*+=<>.?/-]*/, {
          cases: {
            "@keywords": "keyword",
            "@operators": "operator",
            "@sorts": "type",
            "@default": "identifier",
          },
        }],
        [/[()]/, "@brackets"],
        [/:\w+/, "attribute.name"],
      ],
    },
  });
}
