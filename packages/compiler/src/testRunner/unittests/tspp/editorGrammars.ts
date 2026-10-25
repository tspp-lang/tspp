import * as Harness from "../../_namespaces/Harness.js";

interface GrammarPattern {
  readonly comment?: string;
  readonly begin?: string;
  readonly beginCaptures?: Readonly<Record<string, GrammarPattern>>;
  readonly contentName?: string;
  readonly end?: string;
  readonly endCaptures?: Readonly<Record<string, GrammarPattern>>;
  readonly include?: string;
  readonly name?: string;
  readonly match?: string;
  readonly patterns?: readonly GrammarPattern[];
  readonly captures?: Readonly<Record<string, GrammarPattern>>;
}

interface Grammar {
  readonly patterns: readonly GrammarPattern[];
  readonly repository?: Readonly<Record<string, GrammarPattern>>;
}

interface LanguageConfiguration {
  readonly colorizedBracketPairs: readonly (readonly [string, string])[];
  readonly surroundingPairs: readonly (readonly [string, string])[];
}

interface ExtensionManifest {
  readonly contributes: {
    readonly grammars: readonly {
      readonly scopeName: string;
      readonly embeddedLanguages?: Readonly<Record<string, string>>;
    }[];
  };
}

describe("unittests:: tspp:: editor grammars", () => {
  const grammarFileNames = [
    "tspp-formal-contracts.tmLanguage.json",
    "tspp-kind-operators.tmLanguage.json",
    "tspp-macros.tmLanguage.json",
    "tspp-nominal-declarations.tmLanguage.json",
    "tspp-operators.tmLanguage.json",
    "tspp-type-computation.tmLanguage.json",
    "tspp-modern-syntax.tmLanguage.json",
  ];

  function readGrammar(fileName: string): Grammar {
    const path = `../vscode-extension/syntaxes/${fileName}`;
    const text = Harness.IO.readFile(path);
    assert.isDefined(text, `Expected to find ${path}`);
    return JSON.parse(text) as Grammar;
  }

  function readLanguageConfiguration(): LanguageConfiguration {
    const path = "../vscode-extension/language-configuration.json";
    const text = Harness.IO.readFile(path);
    assert.isDefined(text, `Expected to find ${path}`);
    return JSON.parse(text) as LanguageConfiguration;
  }

  function readExtensionManifest(): ExtensionManifest {
    const path = "../vscode-extension/package.json";
    const text = Harness.IO.readFile(path);
    assert.isDefined(text, `Expected to find ${path}`);
    return JSON.parse(text) as ExtensionManifest;
  }

  function collectPatterns(grammar: Grammar): readonly GrammarPattern[] {
    const result: GrammarPattern[] = [];
    const visit = (pattern: GrammarPattern) => {
      result.push(pattern);
      pattern.patterns?.forEach(visit);
      Object.values(pattern.beginCaptures ?? {}).forEach(visit);
      Object.values(pattern.captures ?? {}).forEach(visit);
      Object.values(pattern.endCaptures ?? {}).forEach(visit);
    };
    grammar.patterns.forEach(visit);
    Object.values(grammar.repository ?? {}).forEach(visit);
    return result;
  }

  it("leaves angle-bracket classification to TypeScript's contextual grammars", () => {
    for (const fileName of grammarFileNames) {
      const patterns = collectPatterns(readGrammar(fileName));
      assert.isFalse(
        patterns.some(pattern => pattern.name === "keyword.operator.relational.ts"),
        `${fileName} must not override contextual angle-bracket classification`,
      );
    }

    const macros = collectPatterns(readGrammar("tspp-macros.tmLanguage.json"));
    assert.isTrue(
      macros.some(pattern => pattern.include === "source.ts#type-annotation"),
      "TS++ declarations should reuse TypeScript's shared type-context grammar",
    );
  });

  it("highlights every contract property supported by with clauses", () => {
    const patterns = collectPatterns(readGrammar("tspp-formal-contracts.tmLanguage.json"));
    const contractPattern = patterns.find(pattern => Object.values(pattern.captures ?? {}).some(capture => capture.name === "keyword.other.contract.tspp"));
    assert.isDefined(contractPattern, "Expected the formal contracts grammar to scope contract property names");
    assert.isDefined(contractPattern.match);
    for (const property of ["requires", "ensures", "invariant", "predicate", "numberModel", "timeout"]) {
      assert.isTrue(
        contractPattern.match.includes(property),
        `Expected the formal contracts grammar to highlight the '${property}' contract property`,
      );
    }
  });

  it("highlights match mltt as a single keyword sequence", () => {
    const patterns = collectPatterns(readGrammar("tspp-type-computation.tmLanguage.json"));
    const mlttMatchPattern = patterns.find(pattern => pattern.name === "keyword.control.flow.ts" && pattern.match?.includes("mltt"));
    assert.isDefined(mlttMatchPattern, "Expected the type-computation grammar to scope 'mltt' as a keyword");
    assert.match("match", new RegExp(mlttMatchPattern.match!));
    assert.match("mltt", new RegExp(mlttMatchPattern.match!));
  });

  it("parses the whole left side of each MLTT match arm as a TypeScript type", () => {
    const patterns = collectPatterns(readGrammar("tspp-type-computation.tmLanguage.json"));
    const matchRegion = patterns.find(pattern => pattern.name === "meta.match.mltt.tspp");
    const typePatternRegion = patterns.find(pattern => pattern.name === "meta.type.pattern.tspp");
    assert.isDefined(matchRegion, "Expected a grammar region for an entire 'match mltt' expression");
    assert.isDefined(typePatternRegion, "Expected a grammar region for MLTT match-arm type patterns");
    assert.strictEqual(typePatternRegion.contentName, "meta.type.ts");
    const operators = collectPatterns(readGrammar("tspp-operators.tmLanguage.json"));
    assert.isTrue(operators.some(pattern => pattern.name?.includes("storage.type.function.arrow.ts") && pattern.match?.includes("=>")));
    assert.isTrue(patterns.some(pattern => pattern.include === "source.ts#type"));
    assert.isTrue(patterns.some(pattern => pattern.include === "source.ts#expression"), "The selected branch must return to TypeScript expression highlighting");
  });

  it("only colorizes structurally unambiguous bracket pairs", () => {
    const configuration = readLanguageConfiguration();
    assert.deepEqual(configuration.colorizedBracketPairs, [["(", ")"], ["[", "]"], ["{", "}"]]);
    assert.notDeepInclude(configuration.colorizedBracketPairs, ["<", ">"]);
    assert.deepInclude(configuration.surroundingPairs, ["<", ">"]);
  });

  it("isolates angle-bearing multi-character operators without capturing generic brackets", () => {
    const operatorScope = "meta.embedded.inline.tspp-operator";
    const patterns = collectPatterns(readGrammar("tspp-operators.tmLanguage.json"));
    const arrowPattern = patterns.find(pattern => pattern.name?.includes("storage.type.function.arrow.ts"));
    const comparisonPattern = patterns.find(pattern => pattern.name?.includes("keyword.operator.comparison.ts"));
    assert.isDefined(arrowPattern);
    assert.isDefined(comparisonPattern);
    assert.include(arrowPattern.name!, operatorScope);
    assert.include(comparisonPattern.name!, operatorScope);
    const arrow = new RegExp(`^(?:${arrowPattern.match})$`);
    const comparison = new RegExp(`^(?:${comparisonPattern.match})$`);
    for (const text of ["->", "=>", "=>>", "<-"]) assert.match(text, arrow);
    for (const text of [">=", "<=", "===", "!==", "==", "!="]) assert.match(text, comparison);
    for (const text of [">", "<"]) {
      assert.notMatch(text, arrow, "A bare angle bracket must remain in TypeScript's contextual grammar");
      assert.notMatch(text, comparison, "A bare angle bracket must remain in TypeScript's contextual grammar");
    }

    const operatorGrammar = readExtensionManifest().contributes.grammars.find(grammar => grammar.scopeName === "tspp.operators");
    assert.isDefined(operatorGrammar);
    assert.strictEqual(operatorGrammar.embeddedLanguages?.[operatorScope], "plaintext");
  });

  it("gives declaration keywords stable scopes across TS++ expression contexts", () => {
    const patterns = collectPatterns(readGrammar("tspp-operators.tmLanguage.json"));
    const exportKeyword = patterns.find(pattern => pattern.name === "keyword.control.export.ts");
    const constKeyword = patterns.find(pattern => pattern.name?.includes("keyword.declaration.const.tspp"));
    assert.isDefined(exportKeyword);
    assert.isDefined(constKeyword);
    assert.strictEqual(exportKeyword.match, "\\bexport\\b");
    assert.strictEqual(constKeyword.match, "\\bconst\\b");
    assert.include(constKeyword.name!, "storage.type.function.ts");
  });

  it("highlights modern syntax let-in and do keywords", () => {
    const patterns = collectPatterns(readGrammar("tspp-modern-syntax.tmLanguage.json"));
    const doPattern = patterns.find(pattern => pattern.match?.includes("do"));
    const letPattern = patterns.find(pattern => pattern.match?.includes("let"));
    const inPattern = patterns.find(pattern => pattern.match?.includes("in"));
    assert.isDefined(doPattern, "Expected modern-syntax grammar to highlight do");
    assert.isDefined(letPattern, "Expected modern-syntax grammar to highlight let");
    assert.isDefined(inPattern, "Expected modern-syntax grammar to highlight in");
    const usePattern = patterns.find(pattern => pattern.match?.includes("use"));
    const arrowPattern = patterns.find(pattern => pattern.match?.includes("<-"));
    assert.isDefined(usePattern, "Expected modern-syntax grammar to highlight use");
    assert.isDefined(arrowPattern, "Expected modern-syntax grammar to highlight <-");
  });

  it("highlights value-level match expressions, or-patterns and guards", () => {
    const patterns = collectPatterns(readGrammar("tspp-nominal-declarations.tmLanguage.json"));
    const matchKeyword = patterns.find(pattern => pattern.match?.includes("match"));
    assert.isDefined(matchKeyword, "Expected match keyword pattern");
    const guardPattern = patterns.find(pattern => pattern.comment?.includes("Match guard"));
    assert.isDefined(guardPattern, "Expected a grammar pattern for match guard");
    assert.isTrue(patterns.some(pattern => pattern.match?.includes("_")), "Expected wildcard pattern support");
    assert.isTrue(patterns.some(pattern => pattern.match?.includes("|")), "Expected or-pattern operator support");
    assert.isTrue(patterns.some(pattern => pattern.match?.includes("[A-Z]")), "Expected constructor pattern support");
  });
});
