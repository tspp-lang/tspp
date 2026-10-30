import * as documents from "../../_namespaces/documents.js";
import * as fakes from "../../_namespaces/fakes.js";
import * as Harness from "../../_namespaces/Harness.js";
import * as ts from "../../_namespaces/ts.js";
import * as vfs from "../../_namespaces/vfs.js";

describe("unittests:: tspp:: operatorSections", () => {
  function createProgram(fileName: string, content: string, options: ts.CompilerOptions = {}) {
    const host = new fakes.CompilerHost(vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    ));
    return ts.createProgram({ host, rootNames: [fileName], options: { noLib: true, strict: true, tsppFeatures: ["operatorSections"], ...options } });
  }

  function semanticMessages(program: ts.Program) {
    return program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  }

  function emitOutput(program: ts.Program, _fileName: string) {
    let emitted = "";
    program.emit(/*targetSourceFile*/ undefined, (outputName, text) => {
      if (outputName.endsWith(".js")) {
        emitted += text;
      }
    });
    return emitted;
  }

  it("requires operatorSections feature flag for placeholder expression", () => {
    const disabledProgram = createProgram("/src/main.ts", `const add1: (x: number) => number = (_ + 1);`, { tsppFeatures: [] });
    assert.deepEqual(semanticMessages(disabledProgram), [
      "TS++ feature 'operatorSections' is not enabled in 'tsppconfig.json'.",
    ]);

    const enabledProgram = createProgram("/src/main.ts", `const add1: (x: number) => number = (_ + 1);`);
    assert.deepEqual(semanticMessages(enabledProgram), []);
  });

  it("desugars single placeholder to unary arrow function", () => {
    const program = createProgram("/src/main.ts", `const add1: (x: number) => number = (_ + 1);`);
    assert.deepEqual(semanticMessages(program), []);
    const output = emitOutput(program, "/src/main.ts");
    assert.match(output, /\(?__p0\)?\s*=>\s*__p0\s*\+\s*1/);
  });

  it("desugars multiple placeholders to multi-parameter arrow function", () => {
    const program = createProgram("/src/main.ts", `const add: (a: number, b: number) => number = (_ + _);`);
    assert.deepEqual(semanticMessages(program), []);
    const output = emitOutput(program, "/src/main.ts");
    assert.match(output, /\(__p0,\s*__p1\)\s*=>\s*__p0\s*\+\s*__p1/);
  });

  it("supports property access and method calls on placeholder", () => {
    const program = createProgram("/src/main.ts", `const getName: (obj: { name: string }) => string = (_.name);`);
    assert.deepEqual(semanticMessages(program), []);
    const output = emitOutput(program, "/src/main.ts");
    assert.match(output, /\(?__p0\)?\s*=>\s*__p0\.name/);
  });

  it("supports placeholders directly in call arguments", () => {
    const program = createProgram(
      "/src/main.ts",
      `
      declare function mapNumbers(fn: (x: number) => number): void;
      mapNumbers(_ * 2);
    `,
    );
    assert.deepEqual(semanticMessages(program), []);
    const output = emitOutput(program, "/src/main.ts");
    assert.match(output, /mapNumbers\(\(\(?__p0\)?\s*=>\s*__p0\s*\*\s*2\)\)/);
  });

  it("leaves normal parentheses without placeholders intact", () => {
    const program = createProgram("/src/main.ts", `const x = (1 + 2);`);
    assert.deepEqual(semanticMessages(program), []);
    const output = emitOutput(program, "/src/main.ts");
    assert.notMatch(output, /__p0/);
  });

  it("provides accurate hover info for placeholders without reporting any", () => {
    const content = "const add1: (x: number) => number = (_ + 1);";
    const files: Record<string, string> = { "/src/main.ts": content };
    const ls = ts.createLanguageService({
      getCompilationSettings: () => ({ noLib: true, strict: true, tsppFeatures: ["operatorSections"] }),
      getScriptFileNames: () => ["/src/main.ts"],
      getScriptVersion: () => "1",
      getScriptSnapshot: f => files[f] ? ts.ScriptSnapshot.fromString(files[f]) : undefined,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
      fileExists: f => !!files[f],
      readFile: f => files[f],
    });
    const holePos = content.indexOf("_");
    const qi = ls.getQuickInfoAtPosition("/src/main.ts", holePos);
    assert.isDefined(qi);
    assert.strictEqual(ts.displayPartsToString(qi.displayParts), "(parameter) _: number");
  });

  it("does not crash codefix / codeAction requests on operator sections", () => {
    const content = "const getName: (obj: { name: string }) => string = (_.name);";
    const files: Record<string, string> = { "/src/main.ts": content };
    const ls = ts.createLanguageService({
      getCompilationSettings: () => ({ noLib: true, strict: true, tsppFeatures: ["operatorSections"] }),
      getScriptFileNames: () => ["/src/main.ts"],
      getScriptVersion: () => "1",
      getScriptSnapshot: f => files[f] ? ts.ScriptSnapshot.fromString(files[f]) : undefined,
      getCurrentDirectory: () => "/",
      getDefaultLibFileName: o => ts.getDefaultLibFilePath(o),
      fileExists: f => !!files[f],
      readFile: f => files[f],
    });
    for (let pos = 0; pos < content.length; pos += 5) {
      assert.doesNotThrow(() => {
        ls.getCodeFixesAtPosition("/src/main.ts", pos, pos, [7043, 7044, 7045, 7046], {}, {});
      });
    }
  });
});
