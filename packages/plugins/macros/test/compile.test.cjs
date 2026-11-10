// End-to-end behavior of compile-time macros, moved here with the feature from the compiler's own unit tests
// (unittests/tspp/macros.ts). Programs are built through the compiler's program-rebuild slot, synchronously,
// asynchronously (in a worker or in this thread), and in a language service.
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages } = require("../../test-support/compile.cjs");
const { macrosPlugin, getMacroExpansions } = require("../dist");

const ts = usePlugins(macrosPlugin);

const looseOptions = { noImplicitAny: false, strict: false };

/** An in-memory compiler host over `files`, recording emitted outputs. */
function createHost(files, options) {
  const host = ts.createCompilerHost(options);
  const outputs = new Map();
  Object.assign(host, {
    fileExists: fileName => fileName in files,
    readFile: fileName => files[fileName],
    getSourceFile: (fileName, languageVersion) => fileName in files ? ts.createSourceFile(fileName, files[fileName], languageVersion, /*setParentNodes*/ true) : undefined,
    writeFile: (fileName, text) => outputs.set(fileName, text),
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "/lib.d.ts",
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: fileName => fileName,
    directoryExists: () => true,
    getDirectories: () => [],
  });
  return { host, outputs };
}

const defaultOptions = { noLib: true, noImplicitAny: false, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };

function build(files, options = {}, configure) {
  const sources = typeof files === "string" ? { "/file.tspp": files } : files;
  const compilerOptions = { ...defaultOptions, ...options };
  const { host, outputs } = createHost(sources, compilerOptions);
  configure?.(host);
  return { host, outputs, program: ts.createProgram({ host, rootNames: Object.keys(sources).filter(name => !name.includes("node_modules")), options: compilerOptions }) };
}

async function buildAsync(files, options = {}, configure) {
  const sources = typeof files === "string" ? { "/file.tspp": files } : files;
  const compilerOptions = { ...defaultOptions, ...options };
  const { host, outputs } = createHost(sources, compilerOptions);
  configure?.(host);
  return { host, outputs, program: await ts.createProgramAsync({ host, rootNames: Object.keys(sources), options: compilerOptions }) };
}

const messages = program => program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));

/** A language service over one in-memory file whose text can change. */
function createService(fileName, content, options) {
  const files = new Map([[fileName, { text: content, version: 1 }]]);
  const host = {
    getCompilationSettings: () => ({ ...defaultOptions, ...options }),
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: name => String(files.get(name)?.version ?? 0),
    getScriptSnapshot: name => files.has(name) ? ts.ScriptSnapshot.fromString(files.get(name).text) : undefined,
    getCurrentDirectory: () => "/",
    getDefaultLibFileName: () => "/lib.d.ts",
    fileExists: name => files.has(name),
    readFile: name => files.get(name)?.text,
  };
  return ts.createLanguageService(host);
}

const exposeTypeNameSource = timeout => `
  macro${timeout ? `({ timeout: ${timeout} })` : ""} function exposeTypeName(targets, context) {
    const target = targets[0];
    const literal = context.factory.createStringLiteral(target.name);
    const declaration = context.factory.createVariableDeclaration(target.name + "TypeName", undefined, context.factory.createLiteralTypeNode(literal), literal);
    return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([declaration]));
  }
`;
const expandingSource = `${exposeTypeNameSource('{ type: "fixed", value: 2, unit: "s" }')}
  interface User { id: number }
  macro exposeTypeName(User);
  const checked: "User" = UserTypeName;
`;

const chainSource = `
  macro function first([target], context) {
    return context.factory.createMacroInvocationStatement(context.factory.createIdentifier("second"), [context.factory.createIdentifier(target.name)]);
  }
  macro function second([target], context) {
    return context.factory.createMacroInvocationStatement(context.factory.createIdentifier("finish"), [context.factory.createIdentifier(target.name)]);
  }
  macro function finish([target], context) {
    const literal = context.factory.createStringLiteral(target.name);
    return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
      context.factory.createVariableDeclaration(target.name + "ExpandedName", undefined, context.factory.createLiteralTypeNode(literal), literal),
    ]));
  }
  interface User { id: number }
  macro first(User);
  const checked: "User" = UserExpandedName;
`;

test("rebuilds the final program from returned statements", () => {
  const { program } = build(expandingSource);
  assert.deepEqual(messages(program), []);
  const file = program.getSourceFile("/file.tspp");
  assert.ok(file.statements.some(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "UserTypeName")));
  const [expansion] = getMacroExpansions(program, "/file.tspp");
  assert.equal(expansion.macroName, "exposeTypeName");
  assert.equal(expandingSource.slice(expansion.start, expansion.start + expansion.length), "macro exposeTypeName(User);");
  assert.match(expansion.text, /var UserTypeName: "User" = "User";/);
});

test("exposes keyword type annotations to typed macros", () => {
  const source = `
    import type { MacroContext, MacroTarget } from "./sdk";
    macro function expose([target]: readonly MacroTarget[], context: MacroContext) {
      const { factory, SyntaxKind, NodeFlags } = context.typescript;
      const declaration = factory.createVariableDeclaration(
        target.name + "TypeName", undefined,
        factory.createKeywordTypeNode(SyntaxKind.StringKeyword),
        factory.createStringLiteral("AAA"),
      );
      return factory.createVariableStatement(
        [factory.createModifier(SyntaxKind.ExportKeyword)],
        factory.createVariableDeclarationList([declaration], NodeFlags.Const),
      );
    }
    interface Box {}
    macro expose(Box);
  `;
  const { program, outputs } = createProgram({
    "/file.tspp": source,
    "/sdk.d.ts": readFileSync(require.resolve("../dist/sdk.d.ts"), "utf8"),
  }, { declaration: true, moduleResolution: ts.ModuleResolutionKind.Node10, noLib: false });
  assert.deepEqual(diagnosticMessages(program), []);
  const [expansion] = getMacroExpansions(program, "/file.tspp");
  assert.equal(expansion.text, 'export const BoxTypeName: string = "AAA";');
  assert.equal(program.emit().emitSkipped, false);
  assert.match(outputs.get("/file.d.ts"), /export declare const BoxTypeName: string;/);
});

test("reports an invalid generated tree and keeps subsequent macro expansions", async () => {
  const content = `
    ${exposeTypeNameSource().replace(", literal);", ', target.name === "Broken" ? "aaa" : literal);')}
    interface Broken {}
    interface User {}
    macro exposeTypeName(Broken);
    macro exposeTypeName(User);
    const checked: "User" = UserTypeName;
  `;
  for (const program of [build(content).program, (await buildAsync(content)).program]) {
    const [diagnostic, ...others] = program.getSemanticDiagnostics();
    assert.deepEqual(others, []);
    assert.match(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"), /Macro 'exposeTypeName' returned an invalid syntax tree/);
    assert.equal(content.slice(diagnostic.start, diagnostic.start + diagnostic.length), "macro exposeTypeName(Broken);");
    const [broken, valid] = getMacroExpansions(program, "/file.tspp");
    assert.equal(broken.text, "");
    assert.match(valid.text, /^var UserTypeName: "User" = "User";$/);
  }
});

test("checks suggestion diagnostics on the expanded file", async () => {
  // The rebuilt file is re-created by the factory; the checker must treat it as the parse tree rather than following
  // `original` to the unexpanded, unbound file.
  const content = `${expandingSource}\nfunction probe() { const unusedLocal = 1; }\n`;
  const codes = program => program.getSuggestionDiagnostics(program.getSourceFile("/file.tspp")).map(diagnostic => diagnostic.code);
  assert.ok(codes(build(content).program).includes(6133));
  assert.ok(codes((await buildAsync(content)).program).includes(6133));
});

test("keeps macro functions in JS, erases invocations, and restores the declaration prefix", () => {
  const { program, outputs } = build(expandingSource, { declaration: true });
  assert.equal(program.emit().emitSkipped, false);
  const js = outputs.get("/file.js");
  const dtspp = outputs.get("/file.d.tspp");
  assert.match(js, /function exposeTypeName/);
  assert.doesNotMatch(js, /timeout|exposeTypeName\(User\)|void/);
  assert.match(js, /var UserTypeName = "User";/);
  assert.match(dtspp, /declare macro\(\{ timeout: \{ type: "fixed", value: 2, unit: "s" \} \}\) function exposeTypeName/);
  assert.match(dtspp, /declare var UserTypeName: "User";/);
  assert.match(outputs.get("/file.d.ts"), /declare function exposeTypeName/);
});

test("does not materialize default options in declaration output", () => {
  const { program, outputs } = build("export macro function usesDefaults() {}", { declaration: true });
  program.emit();
  assert.match(outputs.get("/file.d.tspp"), /export declare macro function usesDefaults\(\): void;/);
});

test("loads source macros and targets through imports", () => {
  const { program } = build({
    "/macros.tspp": `export ${exposeTypeNameSource()}`,
    "/models.tspp": "export interface User { id: number }",
    "/index.tspp": `
      import { exposeTypeName } from "./macros";
      import { User } from "./models";
      macro exposeTypeName(User);
      export const checked: "User" = UserTypeName;
    `,
  }, { noUnusedLocals: true, moduleResolution: ts.ModuleResolutionKind.Node10 });
  assert.deepEqual(messages(program), []);
  const { outputs } = { outputs: new Map() };
  program.emit(undefined, (fileName, text) => outputs.set(fileName, text));
  // Both imports are only named by the invocation, so neither survives in JavaScript.
  assert.doesNotMatch(outputs.get("/index.js"), /require/);
});

test("loads source dependencies imported by a macro implementation", async () => {
  const { program } = await buildAsync({
    "/helper.tspp": 'export const prefix = "Imported";',
    "/macros.tspp": `
      import { prefix } from "./helper";
      export macro function expose(_targets, context) {
        const literal = context.factory.createStringLiteral(prefix);
        return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
          context.factory.createVariableDeclaration("ImportedName", undefined, context.factory.createLiteralTypeNode(literal), literal),
        ]));
      }
    `,
    "/index.tspp": `
      import { expose } from "./macros";
      macro expose();
      const checked: "Imported" = ImportedName;
    `,
  }, { moduleResolution: ts.ModuleResolutionKind.Node10 });
  assert.deepEqual(messages(program), []);
  assert.match(getMacroExpansions(program, "/index.tspp")[0].text, /var ImportedName: "Imported" = "Imported";/);
});

test("does not execute unrelated top-level statements while loading a macro", () => {
  const { program } = build(`
    const prefix = "safe";
    macro function expose(_targets, context) {
      return context.factory.createExpressionStatement(context.factory.createStringLiteral(prefix));
    }
    throw "ordinary runtime code must not execute during compilation";
    macro expose();
  `);
  assert.deepEqual(messages(program), []);
  assert.equal(getMacroExpansions(program)[0].text, '"safe";');
});

test("preserves diagnostic categories reported by macros and workers", async () => {
  const { program } = await buildAsync(`
    macro function warn(_targets, context) {
      context.report({ message: "review this declaration", category: 0 });
    }
    macro warn();
  `);
  const diagnostic = program.getSemanticDiagnostics().find(item => ts.flattenDiagnosticMessageText(item.messageText, "\n").includes("review this declaration"));
  assert.equal(diagnostic?.category, ts.DiagnosticCategory.Warning);
});

test("turns validation failures into diagnostics", () => {
  const { program } = build(`
    macro function reject(_targets, context) {
      return context.fail("User must have an id");
    }
    interface User {}
    macro reject(User);
  `);
  assert.match(messages(program).join("\n"), /User must have an id/);
  assert.equal(getMacroExpansions(program, "/file.tspp")[0].text, "");
});

test("reports names that are not macro functions", () => {
  const { program } = build(`
    function plain() {}
    macro plain();
  `);
  assert.match(messages(program).join("\n"), /'plain' is not a macro function\./);
});

test("awaits promise results through createProgramAsync", async () => {
  const { program } = await buildAsync(`
    declare const Promise: any;
    macro function exposeLater([target], context) {
      return Promise.resolve().then(() => context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
        context.factory.createVariableDeclaration(target.name + "AsyncName", undefined,
          context.factory.createLiteralTypeNode(context.factory.createStringLiteral(target.name)), context.factory.createStringLiteral(target.name)),
      ])));
    }
    interface User { id: number }
    macro exposeLater(User);
    const checked: "User" = UserAsyncName;
  `);
  assert.deepEqual(messages(program), []);
  assert.match(getMacroExpansions(program, "/file.tspp")[0].text, /var UserAsyncName: "User" = "User";/);
});

test("recursively expands macro invocations returned by macros", async () => {
  const { program, outputs } = await buildAsync(chainSource);
  assert.deepEqual(messages(program), []);
  const expansion = getMacroExpansions(program, "/file.tspp")[0].text;
  assert.match(expansion, /var UserExpandedName: "User" = "User";/);
  assert.doesNotMatch(expansion, /second|finish/);
  program.emit();
  assert.match(outputs.get("/file.js"), /var UserExpandedName = "User";/);
});

test("recursively expands macro invocations in a synchronous program", () => {
  const { program } = build(chainSource);
  assert.deepEqual(messages(program), []);
  assert.match(getMacroExpansions(program)[0].text, /var UserExpandedName: "User" = "User";/);
});

test("limits recursive macro expansion depth", async () => {
  const { program } = await buildAsync(`
    macro function recurse([target], context) {
      return context.factory.createMacroInvocationStatement(context.factory.createIdentifier("recurse"), [context.factory.createIdentifier(target.name)]);
    }
    interface User {}
    macro recurse(User);
  `);
  assert.match(messages(program).join("\n"), /maximum recursive depth of 32/);
});

test("turns asynchronous rejections into macro diagnostics", async () => {
  const { program } = await buildAsync(`
    macro function rejectLater() {
      return { then(_resolve, reject) { reject("later failure"); } };
    }
    macro rejectLater();
  `);
  assert.match(messages(program).join("\n"), /later failure/);
});

test("times out asynchronous macros that never settle", async () => {
  const { program } = await buildAsync(`
    macro({ timeout: { type: "fixed", value: 10, unit: "ms" } }) function waitForever() {
      return { then() {} };
    }
    macro waitForever();
  `);
  assert.match(messages(program).join("\n"), /timed out after 10 ms/);
});

test("terminates a worker when a synchronous macro exceeds its budget", async () => {
  const { program } = await buildAsync(`
    macro({ timeout: { type: "fixed", value: 20, unit: "ms" } }) function blockForever() {
      while (true) {}
    }
    macro blockForever();
  `);
  const text = messages(program).join("\n");
  assert.match(text, /Macro execution/);
  assert.match(text, /timed out after 20 ms/);
});

test("supports machine-relative timeout multipliers", async () => {
  const { program } = await buildAsync(`
    macro({ timeout: { type: "benchmark", multiplier: 2 } }) function waitForever() {
      return { then() {} };
    }
    macro waitForever();
  `, {}, host => {
    // Keep the derived deadline comfortably above worker scheduling jitter.
    host.macroBenchmarkMs = 50;
  });
  assert.match(messages(program).join("\n"), /timed out after 100 ms \(2x local benchmark/);
});

test("reports invalid timeout options without running the macro", () => {
  const { program } = build(`
    macro({ timeout: soon }) function shouldNotRun(_targets, context) {
      return context.fail("the macro unexpectedly ran");
    }
    macro shouldNotRun();
  `);
  const text = messages(program).join("\n");
  assert.match(text, /must match/);
  assert.doesNotMatch(text, /unexpectedly ran/);
});

test("checks timeout values as a closed discriminated union", () => {
  for (const timeout of [
    '{ type: "fixed", value: 1, unit: "minutes" }',
    '{ type: "fixed", value: 0, unit: "ms" }',
    '{ type: "fixed", value: 1e309, unit: "ms" }',
    '{ type: "fixed", value: 2147484, unit: "s" }',
    '{ type: "benchmark", multiplier: 1, unit: "ms" }',
    '{ type: "benchmark", multiplier: 1e309 }',
    '{ type: "later", value: 1 }',
  ]) {
    const { program } = build(`
      macro({ timeout: ${timeout} }) function shouldNotRun(_targets, context) {
        return context.fail("the macro unexpectedly ran");
      }
      macro shouldNotRun();
    `);
    const text = messages(program).join("\n");
    assert.match(text, /must match/, timeout);
    assert.doesNotMatch(text, /unexpectedly ran/, timeout);
  }
});

test("rejects duplicate and unknown options without running the macro", () => {
  const { program } = build(`
    macro({
      timeout: { type: "fixed", value: 1, unit: "s" },
      timeout: { type: "fixed", value: 2, unit: "s" },
      cache: "content",
    }) function shouldNotRun(_targets, context) {
      return context.fail("the macro unexpectedly ran");
    }
    macro shouldNotRun();
  `);
  const text = messages(program).join("\n");
  assert.match(text, /macro option 'timeout' may only be specified once/);
  assert.match(text, /macro option 'cache' is not supported/);
  assert.doesNotMatch(text, /unexpectedly ran/);
});

test("reports option errors at their source position", () => {
  const content = 'macro({ cache: "content" }) function configured() {}';
  const { program } = build(content);
  const [diagnostic] = program.getSemanticDiagnostics();
  assert.equal(content.slice(diagnostic.start, diagnostic.start + diagnostic.length), "cache");
});

test("runs macros with the compiler process's Node.js capabilities", () => {
  const { program } = build(`
    declare function require(name: string): any;
    macro function exposePathBasename(_targets, context) {
      const value = require("path").basename("/workspace/example.tspp");
      const literal = context.factory.createStringLiteral(value);
      return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
        context.factory.createVariableDeclaration("macroPathBasename", undefined, context.factory.createLiteralTypeNode(literal), literal),
      ]));
    }
    macro exposePathBasename();
    const checked: "example.tspp" = macroPathBasename;
  `);
  assert.deepEqual(messages(program), []);
});

test("leaves `macro` as an ordinary name where it does not start macro syntax", () => {
  const { program } = build(`
    const macro = (value: number) => value;
    const doubled = macro(2) + macro (3);
    const object = { macro: 1 };
    const read = object.macro;
    const text = \`macro first(User);\`;
  `, { strict: true });
  assert.deepEqual(diagnosticMessages(program), []);
  assert.deepEqual(getMacroExpansions(program), []);
});

const hostOptions = { moduleResolution: ts.ModuleResolutionKind.Node10 };
const exposeSource = (name, valueExpression) => `
  export macro function expose(_targets, context) {
    const literal = context.factory.createStringLiteral(${valueExpression});
    return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
      context.factory.createVariableDeclaration("${name}", undefined, context.factory.createLiteralTypeNode(literal), literal),
    ]));
  }
`;

/** A host that evaluates macro modules itself, as the playground does, and records what it was asked for. */
function evaluatingHost(evaluated, hostRequired) {
  const hostModules = {
    "virtual-dependency": { prefix: "FromHost" },
    "virtual-macros": {
      expose: (_targets, context) => {
        const literal = context.factory.createStringLiteral("External");
        return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
          context.factory.createVariableDeclaration("ExternalName", undefined, context.factory.createLiteralTypeNode(literal), literal),
        ]));
      },
    },
  };
  return host => {
    host.evaluateMacroModule = (javascript, fileName, requireLocal, module) => {
      evaluated.push(fileName);
      const require = specifier => {
        const local = requireLocal(specifier);
        if (local !== undefined) return local;
        hostRequired.push(specifier);
        if (Object.hasOwn(hostModules, specifier)) return hostModules[specifier];
        throw new Error(`Host does not provide '${specifier}'.`);
      };
      new Function("require", "exports", "module", "__filename", "__dirname", javascript)(require, module.exports, module, fileName, "/");
    };
  };
}

test("evaluates local macro modules and their dependencies through the host", async () => {
  const evaluated = [];
  const hostRequired = [];
  const { program } = await buildAsync({
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
  }, hostOptions, evaluatingHost(evaluated, hostRequired));
  assert.deepEqual(messages(program), []);
  assert.deepEqual(evaluated, ["/macros.tspp", "/helper.tspp"]);
  assert.deepEqual(hostRequired, ["virtual-dependency"]);
});

test("loads external macro packages through the host", () => {
  const evaluated = [];
  const hostRequired = [];
  const { program } = build({
    "/node_modules/virtual-macros/package.json": JSON.stringify({ name: "virtual-macros", tsppTypes: "index.d.tspp" }),
    "/node_modules/virtual-macros/index.d.tspp": "export declare macro function expose(targets: readonly unknown[], context: unknown): unknown;",
    "/index.tspp": `
      import { expose } from "virtual-macros";
      macro expose();
      const checked: "External" = ExternalName;
    `,
  }, hostOptions, evaluatingHost(evaluated, hostRequired));
  assert.deepEqual(messages(program), []);
  assert.deepEqual(evaluated, ["/index.tspp"]);
  assert.deepEqual(hostRequired, ["virtual-macros"]);
});

test("reports host refusals as macro diagnostics without falling back to Node", () => {
  const { program } = build(`
    declare function require(name: string): any;
    ${exposeSource("PathName", 'require("path").basename("/a/b.tspp")')}
    macro expose();
  `, hostOptions, evaluatingHost([], []));
  assert.match(messages(program).join("\n"), /Host does not provide 'path'\./);
});

test("keeps language-service requests usable while refreshing after an asynchronous macro settles", async () => {
  const content = `
    macro function exposeLater([target], context) {
      return { then(resolve) {
        resolve(context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
          context.factory.createVariableDeclaration(target.name + "AsyncName", undefined,
            context.factory.createLiteralTypeNode(context.factory.createStringLiteral(target.name)), context.factory.createStringLiteral(target.name)),
        ])));
      } };
    }
    interface User { id: number }
    macro exposeLater(User);
    const checked: "User" = UserAsyncName;
  `;
  const service = createService("/file.tspp", content);
  const initial = service.getSemanticDiagnostics("/file.tspp").map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
  assert.match(initial.join("\n"), /UserAsyncName/);

  await new Promise(resolve => setTimeout(resolve, 0));

  const classifications = service.getEncodedSemanticClassifications("/file.tspp", { start: 0, length: content.length }, ts.SemanticClassificationFormat.TwentyTwenty);
  assert.ok(classifications.spans.length);
  assert.deepEqual(service.getSemanticDiagnostics("/file.tspp").map(diagnostic => diagnostic.messageText), []);
  const file = service.getProgram().getSourceFile("/file.tspp");
  assert.ok(file.statements.some(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "UserAsyncName")));
});

test("refreshes language-service diagnostics after an asynchronous macro times out", async () => {
  const service = createService("/file.tspp", `
    macro({ timeout: { type: "fixed", value: 10, unit: "ms" } }) function waitForever(): Promise<never> {
      return new Promise(() => {});
    }
    macro waitForever();
  `);
  const text = () => service.getSemanticDiagnostics("/file.tspp").map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")).join("\n");
  assert.doesNotMatch(text(), /timed out/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.match(text(), /timed out after 10 ms/);
});

test("keeps editor positions and quick info aligned with the original source", () => {
  const content = `
    /** Checks the selected declarations. */
    macro function validate() {}
    interface User { id: number }
    macro validate(User);
    const user: User = { id: 1 };
  `;
  const service = createService("/file.tspp", content, { noLib: true });
  const macroPosition = content.indexOf("validate(User)");
  const macroInfo = service.getQuickInfoAtPosition("/file.tspp", macroPosition + 1);
  assert.match(ts.displayPartsToString(macroInfo.displayParts), /validate/);
  assert.equal(ts.displayPartsToString(macroInfo.documentation), "Checks the selected declarations.");

  const targetInfo = service.getQuickInfoAtPosition("/file.tspp", content.indexOf("User);", macroPosition) + 1);
  assert.match(ts.displayPartsToString(targetInfo.displayParts), /interface User/);

  const references = service.findReferences("/file.tspp", content.indexOf("User {") + 1);
  assert.ok(references[0].references.some(reference => reference.textSpan.start === content.indexOf("User);", macroPosition)));
  assert.ok(!service.getSemanticDiagnostics("/file.tspp").some(diagnostic => diagnostic.code === 6133));
});

test("names exported types and values of a module as invocation targets", () => {
  const { program } = build(`
    ${exposeTypeNameSource()}
    export interface User { id: number }
    export const settings = { mode: "fast" };
    macro exposeTypeName(User);
    macro exposeTypeName(settings);
    export const checked: ["User", "settings"] = [UserTypeName, settingsTypeName];
  `);
  assert.deepEqual(messages(program), []);
});

test("does not report generated declarations as unused", () => {
  const { program } = build(`
    export {};
    ${exposeTypeNameSource()}
    interface User { id: number }
    macro exposeTypeName(User);
  `, { noUnusedLocals: true });
  assert.deepEqual(messages(program), []);
});

test("a language service keeps its program until a file changes, and then expands macros again", () => {
  const source = target => `
    macro function named([target], context) {
      return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
        context.factory.createVariableDeclaration(target.name + "Name", undefined, undefined, context.factory.createStringLiteral(target.name))]));
    }
    interface ${target} { a: number }
    macro named(${target});
    export const name = ${target}Name;`;
  let text = source("First");
  let version = 1;
  const options = { noLib: true, target: ts.ScriptTarget.ES2022 };
  const service = ts.createLanguageService({
    getScriptFileNames: () => ["/main.tspp"],
    getScriptVersion: () => String(version),
    getScriptSnapshot: name => name === "/main.tspp" ? ts.ScriptSnapshot.fromString(text) : undefined,
    getCurrentDirectory: () => "/",
    getCompilationSettings: () => options,
    getDefaultLibFileName: () => "/lib.d.ts",
    fileExists: name => name === "/main.tspp",
    readFile: name => name === "/main.tspp" ? text : undefined,
  });
  const program = service.getProgram();
  assert.equal(getMacroExpansions(program, "/main.tspp").length, 1);
  service.getQuickInfoAtPosition("/main.tspp", text.indexOf("First"));
  assert.equal(service.getProgram(), program);

  text = source("Second");
  version++;
  const changed = service.getProgram();
  assert.notEqual(changed, program);
  assert.match(getMacroExpansions(changed, "/main.tspp")[0].text, /SecondName/);
});
