import * as Harness from "../../_namespaces/Harness.js";
import * as ts from "../../_namespaces/ts.js";

describe("unittests:: config:: initTSConfig", () => {
  function initTSConfigCorrectly(name: string, commandLinesArgs: string[]) {
    describe(name, () => {
      const commandLine = ts.parseCommandLine(commandLinesArgs);
      const initResult = ts.generateTSConfig(commandLine.options, "\n");
      const outputFileName = `config/initTSConfig/${name.replace(/[^a-z0-9\-. ]/gi, "")}/tsconfig.json`;

      it(`Correct output for ${outputFileName}`, () => {
        Harness.Baseline.runBaseline(outputFileName, initResult, { PrintDiff: true });
      });
    });
  }

  initTSConfigCorrectly("Default initialized TSConfig", ["--init"]);

  initTSConfigCorrectly("Initialized TSConfig with files options", ["--init", "file0.st", "file1.ts", "file2.ts"]);

  initTSConfigCorrectly("Initialized TSConfig with boolean value compiler options", ["--init", "--noUnusedLocals"]);

  initTSConfigCorrectly("Initialized TSConfig with enum value compiler options", ["--init", "--target", "es5", "--jsx", "react"]);

  initTSConfigCorrectly("Initialized TSConfig with list compiler options", ["--init", "--types", "jquery,mocha"]);

  initTSConfigCorrectly("Initialized TSConfig with list compiler options with enum value", ["--init", "--lib", "es5,es2015.core"]);

  initTSConfigCorrectly("Initialized TSConfig with incorrect compiler option", ["--init", "--someNonExistOption"]);

  initTSConfigCorrectly("Initialized TSConfig with incorrect compiler option value", ["--init", "--lib", "nonExistLib,es5,es2015.promise"]);

  initTSConfigCorrectly("Initialized TSConfig with advanced options", ["--init", "--declaration", "--declarationDir", "lib", "--skipLibCheck", "--noErrorTruncation"]);

  initTSConfigCorrectly("Initialized TSConfig with --help", ["--init", "--help"]);

  initTSConfigCorrectly("Initialized TSConfig with --watch", ["--init", "--watch"]);

  it("generates a versioned TS++ config with every feature disabled", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    const result = ts.generateTsppConfig(commit, "\n");
    assert.include(result, `compiler commit ${commit}`);
    assert.include(result, `"extends": "./tsconfig.json"`);
    for (const definition of ts.tsppFeatureDefinitions) {
      assert.include(result, `// "${definition.name}",`);
      assert.notInclude(result, `      "${definition.name}",`);
    }
    assert.include(result, "获得：newtype 名义类型声明、data 代数数据类型声明与对应变体构造器，以及值层 match 模式匹配表达式。");
    assert.include(result, "影响：TS超集=是；透明擦除=否（生成运行时构造器与匹配分派）。");
  });

  it("validates TS++ feature dependencies without enabling them implicitly", () => {
    const host: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: true,
      fileExists: ts.returnFalse,
      readFile: ts.returnUndefined,
      readDirectory: () => [],
    };
    const parsed = ts.parseJsonConfigFileContent(
      { compilerOptions: { tsppFeatures: ["dependentFunctionTypes"] } },
      host,
      "/project",
      /*existingOptions*/ undefined,
      "/project/tsppconfig.json",
    );
    assert.include(parsed.errors.map(error => error.code), 18071);
    assert.deepEqual(parsed.options.tsppFeatures, ["dependentFunctionTypes"]);

    const wrongFile = ts.parseJsonConfigFileContent(
      { compilerOptions: { tsppFeatures: ["higherKindedTypes"] } },
      host,
      "/project",
      /*existingOptions*/ undefined,
      "/project/tsconfig.json",
    );
    assert.include(wrongFile.errors.map(error => error.code), 18069);
  });

  it("does not discover TS++ extensions without a tsppconfig", () => {
    assert.notInclude(ts.flatten(ts.getSupportedExtensions({})), ts.Extension.Tspp);
    assert.include(ts.flatten(ts.getSupportedExtensions({ configFilePath: "/project/tsppconfig.json" })), ts.Extension.Tspp);
  });
});
