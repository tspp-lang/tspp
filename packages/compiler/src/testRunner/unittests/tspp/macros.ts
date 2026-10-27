import * as documents from "../../_namespaces/documents.js";
import * as fakes from "../../_namespaces/fakes.js";
import * as Harness from "../../_namespaces/Harness.js";
import * as ts from "../../_namespaces/ts.js";
import * as vfs from "../../_namespaces/vfs.js";

describe("unittests:: tspp:: macros", () => {
  function createProgram(content: string, options: ts.CompilerOptions = {}) {
    const fileName = "/file.tspp";
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
      ...options,
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    return { fs, program: ts.createProgram({ host, rootNames: [fileName], options: compilerOptions }) };
  }

  async function createAsyncProgram(content: string, options: ts.CompilerOptions = {}) {
    const fileName = "/file.tspp";
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
      ...options,
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument(fileName, content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    return { fs, program: await ts.createProgramAsync({ host, rootNames: [fileName], options: compilerOptions }) };
  }

  const expandingSource = `
    macro function exposeTypeName(targets, context) with { timeout: { type: "fixed", value: 2, unit: "s" }; } {
      const target = targets[0];
      const literal = context.factory.createStringLiteral(target.name);
      const declaration = context.factory.createVariableDeclaration(
        target.name + "TypeName",
        undefined,
        context.factory.createLiteralTypeNode(literal),
        literal,
      );
      return context.factory.createVariableStatement(
        undefined,
        context.factory.createVariableDeclarationList([declaration]),
      );
    }

    interface User { id: number }
    macro exposeTypeName(User);
    const checked: "User" = UserTypeName;
  `;

  const recursiveExpansionSource = `
    macro function first([target], context) {
      return context.factory.createMacroInvocationStatement(
        context.factory.createIdentifier("second"),
        [context.factory.createIdentifier(target.name)],
      );
    }
    macro function second([target], context) {
      return context.factory.createMacroInvocationStatement(
        context.factory.createIdentifier("finish"),
        [context.factory.createIdentifier(target.name)],
      );
    }
    macro function finish([target], context) {
      return context.factory.createVariableStatement(
        undefined,
        context.factory.createVariableDeclarationList([
          context.factory.createVariableDeclaration(
            target.name + "ExpandedName",
            undefined,
            context.factory.createLiteralTypeNode(context.factory.createStringLiteral(target.name)),
            context.factory.createStringLiteral(target.name),
          ),
        ]),
      );
    }
    interface User { id: number }
    macro first(User);
    const checked: "User" = UserExpandedName;
  `;

  it("parses and prints declaration-level with clauses", () => {
    const file = ts.createSourceFile(
      "/file.tspp",
      'macro function analyzeProject(Project) with { timeout: { type: "benchmark", multiplier: 100 }; }: Result {}',
      ts.ScriptTarget.Latest,
      /*setParentNodes*/ true,
    );
    assert.isEmpty(file.parseDiagnostics);
    const declaration = file.statements[0] as ts.FunctionDeclaration;
    assert.isTrue(ts.isFunctionDeclaration(declaration));
    assert.equal(declaration.withClause?.properties.length, 1);
    assert.equal(declaration.withClause!.properties[0].name.text, "timeout");
    assert.isTrue(ts.isObjectLiteralExpression(declaration.withClause!.properties[0].value));
    assert.include(ts.createPrinter().printFile(file), 'timeout: { type: "benchmark", multiplier: 100 }');
  });

  it("rebuilds the final program from returned statements", () => {
    const { program } = createProgram(expandingSource);
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));

    const file = program.getSourceFile("/file.tspp")!;
    assert.include(file.text, "macro exposeTypeName(User)");
    assert.isTrue(file.statements.some(ts.isMacroInvocationStatement));
    assert.isTrue(file.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "UserTypeName")));

    const [expansion] = program.getMacroExpansions!("/file.tspp");
    assert.equal(expansion.taskKind, "macro");
    assert.equal(expansion.outcome, "succeeded");
    assert.match(expansion.taskId, /^macro:/);
    assert.deepEqual(program.getAnalysisArtifacts!(), [expansion]);
    assert.equal(expansion.macroName, "exposeTypeName");
    assert.equal(expandingSource.slice(expansion.start, expansion.start + expansion.length), "macro exposeTypeName(User);");
    assert.include(expansion.text, 'var UserTypeName: "User" = "User";');
  });

  it("checks suggestion diagnostics on the expanded file", async () => {
    // The expanded file is rebuilt by the factory; the checker must treat it as the
    // parse tree rather than following `original` to the unexpanded, unbound file.
    const content = expandingSource + "\nfunction probe() { const unusedLocal = 1; }\n";
    const suggestionCodes = (program: ts.Program) => program.getSuggestionDiagnostics(program.getSourceFile("/file.tspp")!).map(diagnostic => diagnostic.code);
    assert.include(suggestionCodes(createProgram(content).program), 6133);
    assert.include(suggestionCodes((await createAsyncProgram(content)).program), 6133);
  });

  it("keeps macro functions in JS, erases calls, and preserves the declaration marker", () => {
    const { fs, program } = createProgram(expandingSource, { declaration: true });
    const result = program.emit();
    assert.isFalse(result.emitSkipped);
    const js = fs.readFileSync("/file.js").toString();
    const dts = fs.readFileSync("/file.d.tspp").toString();

    assert.include(js, "function exposeTypeName");
    assert.notInclude(js, "with { timeout");
    assert.notInclude(js, "macro exposeTypeName");
    assert.include(js, 'var UserTypeName = "User";');
    assert.include(dts, "declare macro function exposeTypeName");
    assert.include(dts, 'with { timeout: { type: "fixed", value: 2, unit: "s" }; }');
    assert.include(dts, 'declare var UserTypeName: "User";');
  });

  it("does not materialize default with properties in declaration output", () => {
    const { fs, program } = createProgram(
      `
      export macro function usesDefaults() {}
    `,
      { declaration: true },
    );
    const result = program.emit();
    assert.isFalse(result.emitSkipped);
    const dts = fs.readFileSync("/file.d.tspp").toString();
    assert.include(dts, "usesDefaults");
    assert.notInclude(dts, "with");
  });

  it("loads source macros and targets through imports", () => {
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      noUnusedLocals: true,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      {
        documents: [
          new documents.TextDocument(
            "/macros.tspp",
            `
            export macro function expose([target], context) {
              return context.factory.createVariableStatement(
                undefined,
                context.factory.createVariableDeclarationList([
                  context.factory.createVariableDeclaration(
                    target.name + "TypeName",
                    undefined,
                    context.factory.createLiteralTypeNode(
                      context.factory.createStringLiteral(target.name),
                    ),
                    context.factory.createStringLiteral(target.name),
                  ),
                ]),
              );
            }
          `,
          ),
          new documents.TextDocument("/models.tspp", "export interface User { id: number }"),
          new documents.TextDocument(
            "/index.tspp",
            `
            import { expose } from "./macros";
            import { User } from "./models";
            macro expose(User);
            export const checked: "User" = UserTypeName;
          `,
          ),
        ],
        cwd: "/",
      },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = ts.createProgram({ host, rootNames: ["/index.tspp"], options: compilerOptions });
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    const file = program.getSourceFile("/index.tspp")!;
    assert.include(file.text, "macro expose(User)");
    assert.isTrue(file.statements.some(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "UserTypeName")));
  });

  it("loads source dependencies imported by a macro implementation", async () => {
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      {
        documents: [
          new documents.TextDocument("/helper.tspp", 'export const prefix = "Imported";'),
          new documents.TextDocument(
            "/macros.tspp",
            `
            import { prefix } from "./helper";
            export macro function expose(_targets, context) {
              const literal = context.factory.createStringLiteral(prefix);
              return context.factory.createVariableStatement(
                undefined,
                context.factory.createVariableDeclarationList([
                  context.factory.createVariableDeclaration("ImportedName", undefined, context.factory.createLiteralTypeNode(literal), literal),
                ]),
              );
            }
          `,
          ),
          new documents.TextDocument(
            "/index.tspp",
            `
            import { expose } from "./macros";
            macro expose();
            const checked: "Imported" = ImportedName;
          `,
          ),
        ],
        cwd: "/",
      },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = await ts.createProgramAsync({ host, rootNames: ["/index.tspp"], options: compilerOptions });
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    assert.include(program.getMacroExpansions!("/index.tspp")[0].text, 'var ImportedName: "Imported" = "Imported";');
  });

  it("does not execute unrelated top-level statements while loading a macro", () => {
    const { program } = createProgram(`
      const prefix = "safe";
      macro function expose(_targets, context) {
        return context.factory.createExpressionStatement(context.factory.createStringLiteral(prefix));
      }
      throw "ordinary runtime code must not execute during compilation";
      macro expose();
    `);
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    assert.equal(program.getMacroExpansions!()[0].text, '"safe";');
  });

  it("preserves diagnostic categories reported by macros and workers", async () => {
    const { program } = await createAsyncProgram(`
      macro function warn(_targets, context) {
        context.report({ message: "review this declaration", category: 0 });
      }
      macro warn();
    `);
    const diagnostic = program.getSemanticDiagnostics().find(d => ts.flattenDiagnosticMessageText(d.messageText, "\n").includes("review this declaration"));
    assert.isDefined(diagnostic);
    assert.equal(diagnostic.category, ts.DiagnosticCategory.Warning);
  });

  it("turns validation failures into diagnostics", () => {
    const { program } = createProgram(`
      macro function reject(_targets, context) {
        return context.fail("User must have an id");
      }
      interface User {}
      macro reject(User);
    `);
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.include(messages.join("\n"), "User must have an id");
    assert.equal(program.getMacroExpansions!("/file.tspp")[0].text, "");
  });

  it("awaits promise results through createProgramAsync", async () => {
    const content = `
      macro function exposeLater([target], context) {
        return Promise.resolve().then(() => context.factory.createVariableStatement(
          undefined,
          context.factory.createVariableDeclarationList([
            context.factory.createVariableDeclaration(
              target.name + "AsyncName",
              undefined,
              context.factory.createLiteralTypeNode(context.factory.createStringLiteral(target.name)),
              context.factory.createStringLiteral(target.name),
            ),
          ]),
        ));
      }
      interface User { id: number }
      macro exposeLater(User);
      const checked: "User" = UserAsyncName;
    `;
    const compilerOptions: ts.CompilerOptions = {
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument("/file.tspp", content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = await ts.createProgramAsync({ host, rootNames: ["/file.tspp"], options: compilerOptions });
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    assert.include(program.getMacroExpansions!("/file.tspp")[0].text, 'var UserAsyncName: "User" = "User";');
  });

  it("recursively expands macro invocations in synchronous programs", () => {
    const { program } = createProgram(recursiveExpansionSource);
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    const expansion = program.getMacroExpansions!("/file.tspp")[0].text;
    assert.include(expansion, 'var UserExpandedName: "User" = "User";');
    assert.notInclude(expansion, "macro second");
    assert.notInclude(expansion, "macro finish");
  });

  it("recursively expands macro invocations returned by macros", async () => {
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument("/file.tspp", recursiveExpansionSource)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = await ts.createProgramAsync({ host, rootNames: ["/file.tspp"], options: compilerOptions });
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
    const expansion = program.getMacroExpansions!("/file.tspp")[0].text;
    assert.include(expansion, 'var UserExpandedName: "User" = "User";');
    assert.notInclude(expansion, "macro second");
    assert.notInclude(expansion, "macro finish");
    let javascript = "";
    program.emit(
      /*targetSourceFile*/ undefined,
      (fileName, text) => {
        if (fileName.endsWith(".js")) javascript = text;
      },
    );
    assert.include(javascript, 'var UserExpandedName = "User";');
  });

  it("limits recursive macro expansion depth", async () => {
    const content = `
      macro function recurse([target], context) {
        return context.factory.createMacroInvocationStatement(
          context.factory.createIdentifier("recurse"),
          [context.factory.createIdentifier(target.name)],
        );
      }
      interface User {}
      macro recurse(User);
    `;
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument("/file.tspp", content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = await ts.createProgramAsync({ host, rootNames: ["/file.tspp"], options: compilerOptions });
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.include(messages.join("\n"), "maximum recursive depth of 32");
  });

  it("turns asynchronous rejections into macro diagnostics", async () => {
    const content = `
      macro function rejectLater() {
        return { then(_resolve, reject) { reject("later failure"); } };
      }
      macro rejectLater();
    `;
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument("/file.tspp", content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = await ts.createProgramAsync({ host, rootNames: ["/file.tspp"], options: compilerOptions });
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.include(messages.join("\n"), "later failure");
  });

  it("times out asynchronous macros that never settle", async () => {
    const content = `
      macro function waitForever() with { timeout: { type: "fixed", value: 10, unit: "ms" }; } {
        return { then() {} };
      }
      macro waitForever();
    `;
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument("/file.tspp", content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = await ts.createProgramAsync({ host, rootNames: ["/file.tspp"], options: compilerOptions });
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.include(messages.join("\n"), "timed out after 10 ms");
  });

  it("terminates a worker when a synchronous macro exceeds its budget", async () => {
    const content = `
      macro function blockForever() with { timeout: { type: "fixed", value: 20, unit: "ms" }; } {
        while (true) {}
      }
      macro blockForever();
    `;
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument("/file.tspp", content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    const program = await ts.createProgramAsync({ host, rootNames: ["/file.tspp"], options: compilerOptions });
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.include(messages.join("\n"), "Macro execution");
    assert.include(messages.join("\n"), "timed out after 20 ms");
  });

  it("supports machine-relative timeout multipliers", async () => {
    const content = `
      macro function waitForever() with { timeout: { type: "benchmark", multiplier: 2 }; } {
        return { then() {} };
      }
      macro waitForever();
    `;
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const fs = vfs.createFromFileSystem(
      Harness.IO,
      /*ignoreCase*/ true,
      { documents: [new documents.TextDocument("/file.tspp", content)], cwd: "/" },
    );
    const host = new fakes.CompilerHost(fs, compilerOptions);
    (host as ts.CompilerHost).macroBenchmarkMs = 5;
    const program = await ts.createProgramAsync({ host, rootNames: ["/file.tspp"], options: compilerOptions });
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.include(messages.join("\n"), "timed out after 10 ms (2x local benchmark");
  });

  it("reports invalid timeout options without running the macro", () => {
    const { program } = createProgram(`
      macro function shouldNotRun(_targets, context) with { timeout: soon; } {
        return context.fail("the macro unexpectedly ran");
      }
      macro shouldNotRun();
    `);
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
    assert.include(messages, "must match");
    assert.notInclude(messages, "the macro unexpectedly ran");
  });

  it("checks timeout values as a closed discriminated union", () => {
    for (
      const timeout of [
        '{ type: "fixed", value: 1, unit: "minutes" }',
        '{ type: "fixed", value: 0, unit: "ms" }',
        '{ type: "fixed", value: 1e309, unit: "ms" }',
        '{ type: "fixed", value: 2147484, unit: "s" }',
        '{ type: "benchmark", multiplier: 1, unit: "ms" }',
        '{ type: "benchmark", multiplier: 1e309 }',
        '{ type: "later", value: 1 }',
      ]
    ) {
      const { program } = createProgram(`
        macro function shouldNotRun(_targets, context) with { timeout: ${timeout}; } {
          return context.fail("the macro unexpectedly ran");
        }
        macro shouldNotRun();
      `);
      const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
      assert.include(messages, "must match");
      assert.notInclude(messages, "the macro unexpectedly ran");
    }
  });

  it("rejects duplicate and unknown options without running the macro", () => {
    const { program } = createProgram(`
      macro function shouldNotRun(_targets, context) with {
        timeout: { type: "fixed", value: 1, unit: "s" };
        timeout: { type: "fixed", value: 2, unit: "s" };
        cache: content;
      } {
        return context.fail("the macro unexpectedly ran");
      }
      macro shouldNotRun();
    `);
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
    assert.include(messages, "property 'timeout' may only be specified once");
    assert.include(messages, "property 'cache' is not supported on a macro function");
    assert.notInclude(messages, "the macro unexpectedly ran");
  });

  it("parses with clauses on regular functions but rejects unsupported properties", () => {
    const { program } = createProgram(`
      function defaults() with {}: void {}
      function configured() with { timeout: { type: "fixed", value: 1, unit: "s" }; }: void {}
    `);
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n");
    assert.include(messages, "property 'timeout' is not supported on a regular function");
  });

  it("runs macros with the compiler process's Node.js capabilities", () => {
    const { program } = createProgram(`
      declare function require(name: string): any;
      macro function exposePathBasename(_targets, context) {
        const path = require("path");
        const value = path.basename("/workspace/example.tspp");
        return context.factory.createVariableStatement(
          undefined,
          context.factory.createVariableDeclarationList([
            context.factory.createVariableDeclaration(
              "macroPathBasename",
              undefined,
              context.factory.createLiteralTypeNode(context.factory.createStringLiteral(value)),
              context.factory.createStringLiteral(value),
            ),
          ]),
        );
      }
      macro exposePathBasename();
      const checked: "example.tspp" = macroPathBasename;
    `);
    const diagnostics = program.getSemanticDiagnostics();
    assert.isEmpty(diagnostics, diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n"));
  });

  describe("host macro evaluation seam", () => {
    const compilerOptions: ts.CompilerOptions = {
      noLib: true,
      noImplicitAny: false,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2022,
      tsppFeatures: ["macros"],
    };
    const exposeSource = (name: string, valueExpression: string) => `
      export macro function expose(_targets, context) {
        const literal = context.factory.createStringLiteral(${valueExpression});
        return context.factory.createVariableStatement(
          undefined,
          context.factory.createVariableDeclarationList([
            context.factory.createVariableDeclaration("${name}", undefined, context.factory.createLiteralTypeNode(literal), literal),
          ]),
        );
      }
    `;

    function createHost(files: Record<string, string>) {
      const fs = vfs.createFromFileSystem(
        Harness.IO,
        /*ignoreCase*/ true,
        { documents: Object.entries(files).map(([fileName, content]) => new documents.TextDocument(fileName, content)), cwd: "/" },
      );
      const host = new fakes.CompilerHost(fs, compilerOptions);
      const evaluated: string[] = [];
      const hostRequired: string[] = [];
      const hostModules: Record<string, unknown> = {
        "virtual-dependency": { prefix: "FromHost" },
        "virtual-macros": {
          expose: (_targets: readonly unknown[], context: { factory: ts.NodeFactory; }) => {
            const literal = context.factory.createStringLiteral("External");
            return context.factory.createVariableStatement(
              /*modifiers*/ undefined,
              context.factory.createVariableDeclarationList([
                context.factory.createVariableDeclaration("ExternalName", /*exclamationToken*/ undefined, context.factory.createLiteralTypeNode(literal), literal),
              ]),
            );
          },
        },
      };
      (host as ts.CompilerHost).evaluateMacroModule = (javascript, fileName, requireLocal, module) => {
        evaluated.push(fileName);
        const require = (specifier: string) => {
          const local = requireLocal(specifier);
          if (local !== undefined) return local;
          hostRequired.push(specifier);
          if (ts.hasProperty(hostModules, specifier)) return hostModules[specifier];
          throw new Error(`Host does not provide '${specifier}'.`);
        };
        // eslint-disable-next-line no-new-func -- Mirrors a non-Node host evaluating the emitted CommonJS module.
        new Function("require", "exports", "module", "__filename", "__dirname", javascript)(require, module.exports, module, fileName, "/");
      };
      return { host, evaluated, hostRequired };
    }

    function messages(program: ts.Program) {
      return program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    }

    it("evaluates local macro modules and their dependencies through the host", async () => {
      const { host, evaluated, hostRequired } = createHost({
        "/helper.tspp": 'export const suffix = "Local";',
        "/macros.tspp": `
          import { suffix } from "./helper";
          declare function require(name: string): any;
          ${exposeSource("SeamName", 'require("virtual-dependency").prefix + suffix')}
        `,
        "/index.tspp": `
          import { expose } from "./macros";
          macro expose();
          const checked: "FromHostLocal" = SeamName;
        `,
      });
      const program = await ts.createProgramAsync({ host, rootNames: ["/index.tspp"], options: compilerOptions });
      assert.deepEqual(messages(program), []);
      assert.deepEqual(evaluated, ["/macros.tspp", "/helper.tspp"]);
      assert.deepEqual(hostRequired, ["virtual-dependency"]);
    });

    it("loads external macro packages through the host", () => {
      const { host, evaluated, hostRequired } = createHost({
        "/node_modules/virtual-macros/package.json": JSON.stringify({ name: "virtual-macros", tsppTypes: "index.d.tspp" }),
        "/node_modules/virtual-macros/index.d.tspp": "export declare macro function expose(targets: readonly unknown[], context: unknown): unknown;",
        "/index.tspp": `
          import { expose } from "virtual-macros";
          macro expose();
          const checked: "External" = ExternalName;
        `,
      });
      const program = ts.createProgram({ host, rootNames: ["/index.tspp"], options: compilerOptions });
      assert.deepEqual(messages(program), []);
      assert.deepEqual(evaluated, ["/index.tspp"]);
      assert.deepEqual(hostRequired, ["virtual-macros"]);
    });

    it("reports host refusals as macro diagnostics without falling back to Node", () => {
      const { host } = createHost({
        "/index.tspp": `
          declare function require(name: string): any;
          ${exposeSource("PathName", 'require("path").basename("/a/b.tspp")')}
          macro expose();
        `,
      });
      const program = ts.createProgram({ host, rootNames: ["/index.tspp"], options: compilerOptions });
      assert.include(messages(program).join("\n"), "Host does not provide 'path'.");
    });
  });

  it("refreshes the language-service program after an asynchronous macro settles", async () => {
    const content = `
      macro function exposeLater([target], context) {
        return { then(resolve) {
          resolve(context.factory.createVariableStatement(
            undefined,
            context.factory.createVariableDeclarationList([
              context.factory.createVariableDeclaration(
                target.name + "AsyncName",
                undefined,
                context.factory.createLiteralTypeNode(context.factory.createStringLiteral(target.name)),
                context.factory.createStringLiteral(target.name),
              ),
            ]),
          ));
        } };
      }
      interface User { id: number }
      macro exposeLater(User);
      const checked: "User" = UserAsyncName;
    `;
    const adapter = new Harness.LanguageService.NativeLanguageServiceAdapter(
      /*cancellationToken*/ undefined,
      {
        noLib: true,
        noImplicitAny: false,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        tsppFeatures: ["macros"],
      },
    );
    const host = adapter.getHost();
    host.addScript("/file.tspp", content, /*isRootFile*/ true);
    const service = adapter.getLanguageService();

    const initial = service.getSemanticDiagnostics("/file.tspp");
    assert.include(initial.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"), "UserAsyncName");

    await new Promise(resolve => setTimeout(resolve, 0));

    const settled = service.getSemanticDiagnostics("/file.tspp");
    assert.isEmpty(settled, settled.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"));
    const file = service.getProgram()!.getSourceFile("/file.tspp")!;
    assert.isTrue(file.statements.some(statement =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "UserAsyncName")
    ));
  });

  it("refreshes language-service diagnostics after an asynchronous macro times out", async () => {
    const content = `
      macro function waitForever() with { timeout: { type: "fixed", value: 10, unit: "ms" }; }: Promise<never> {
        return new Promise(() => {});
      }
      macro waitForever();
    `;
    const adapter = new Harness.LanguageService.NativeLanguageServiceAdapter(
      /*cancellationToken*/ undefined,
      {
        noImplicitAny: false,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        tsppFeatures: ["macros"],
      },
    );
    const host = adapter.getHost();
    host.addScript("/file.tspp", content, /*isRootFile*/ true);
    const service = adapter.getLanguageService();

    const initial = service.getSemanticDiagnostics("/file.tspp");
    assert.notInclude(initial.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"), "timed out");

    await new Promise(resolve => setTimeout(resolve, 30));

    const settled = service.getSemanticDiagnostics("/file.tspp");
    assert.include(settled.map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n"), "timed out after 10 ms");
  });

  it("requires the macros feature flag", () => {
    const { program } = createProgram(
      `
      macro function validate() {}
      macro validate();
    `,
      { tsppFeatures: [] },
    );
    const messages = program.getSemanticDiagnostics().map(d => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    assert.match(messages.join("\n"), /feature 'macros' is not enabled/);
  });

  it("keeps editor positions and quick info aligned with the original source", () => {
    const content = `
      /** Checks the selected declarations. */
      macro function validate() {}
      interface User { id: number }
      macro validate(User);
      const user: User = { id: 1 };
    `;
    const adapter = new Harness.LanguageService.NativeLanguageServiceAdapter(
      /*cancellationToken*/ undefined,
      {
        noLib: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        tsppFeatures: ["macros"],
      },
    );
    const host = adapter.getHost();
    host.addScript("file.tspp", content, /*isRootFile*/ true);
    const service = adapter.getLanguageService();
    const macroPosition = content.indexOf("validate(User)");
    const macroInfo = service.getQuickInfoAtPosition("file.tspp", macroPosition + 1)!;
    assert.include(ts.displayPartsToString(macroInfo.displayParts), "validate");
    assert.equal(ts.displayPartsToString(macroInfo.documentation), "Checks the selected declarations.");

    const targetPosition = content.indexOf("User);", macroPosition);
    const targetInfo = service.getQuickInfoAtPosition("file.tspp", targetPosition + 1)!;
    assert.include(ts.displayPartsToString(targetInfo.displayParts), "interface User");

    const diagnostics = service.getSemanticDiagnostics("file.tspp");
    assert.notInclude(diagnostics.map(diagnostic => diagnostic.code), 6133);
  });
});
