// End-to-end behavior ported from the legacy-monolith compiler tests (unittests/tspp/modernSyntax.ts).
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
const { modernSyntaxPlugin } = require("../dist");

usePlugins(modernSyntaxPlugin);

function compile(source) {
  const { program, outputs } = createProgram(source);
  return { messages: diagnosticMessages(program), javascript: () => emitJavaScript(program, outputs) };
}

test("infers let-in types and lowers the bindings into a returned block", () => {
  const result = compile(`
    declare function takesNumber(n: number): void;
    const res = let x = 10, y = 20 in x + y;
    takesNumber(res);
  `);
  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /let x = 10, y = 20;/);
  assert.match(js, /return x \+ y;/);
});

test("requires every let-in binding to be initialized", () => {
  const { messages } = compile(`
    const unread = let x in 1;
    const read = let a = 1, b: number in a + b;
  `);
  assert.equal(messages.filter(message => message === "'let' declarations must be initialized.").length, 2, messages.join("\n"));
  // A plugin syntax error without a code of its own gets the host's generic plugin code.
  const { program } = createProgram("const unread = let x in 1;");
  assert.deepEqual(program.getSyntacticDiagnostics().map(diagnostic => diagnostic.code), [18086]);
});

test("infers a do expression from its completion value", () => {
  const result = compile(`
    declare function takesString(s: string): void;
    const res = do {
      const hello = "world";
      hello;
    };
    takesString(res);
  `);
  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /const hello = "world";/);
  assert.match(js, /return hello;/);
});

test("returns the completion value of do functions and methods but not of ordinary functions", () => {
  const result = compile(`
    declare function takesNumber(n: number): void;
    declare function takesVoid(v: void): void;
    function doFunc(): number do {
      const x = 5;
      x + 10;
    }
    function normalFunc(): void {
      const y = 5;
      y + 10;
    }
    class Service {
      compute(): number do {
        100;
      }
    }
    takesNumber(doFunc());
    takesVoid(normalFunc());
    takesNumber(new Service().compute());
  `);
  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /return x \+ 10;/);
  assert.doesNotMatch(js, /return y \+ 10;/);
  assert.match(js, /return 100;/);
});

test("returns the completion value of each if branch", () => {
  const result = compile(`
    declare const cond: boolean;
    declare function takesNumber(n: number): void;
    const val = do {
      if (cond) {
        1;
      } else {
        2;
      }
    };
    takesNumber(val);
  `);
  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /return 1;/);
  assert.match(js, /return 2;/);
});

test("checks a do function's completion value against its return type", () => {
  const { messages } = compile(`
    function calculateDiscount(price: number, isVip: boolean): number do {
      "";
    }
  `);
  assert.deepEqual(messages, ["Type 'string' is not assignable to type 'number'."]);
});

test("rejects a use binding outside a do block or do function", () => {
  const { messages } = compile(`
    declare function withRes<T>(cb: (x: number) => T): T;
    function normalBlock() {
      use x <- withRes();
      x + 1;
    }
  `);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /trailing-closure binding is only allowed directly inside a completion-valued block/);
});

test("desugars a use binding into a trailing closure", () => {
  const result = compile(`
    declare function withResource<T>(fn: (res: string) => T): T;
    declare function takesString(s: string): void;
    const val = do {
      use r <- withResource();
      takesString(r);
      r;
    };
    takesString(val);
  `);
  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /return withResource\(r => \{/);
  assert.match(js, /return r;/);
});

test("nests chained use bindings", () => {
  const result = compile(`
    declare function withA<T>(fn: (a: number) => T): T;
    declare function withB<T>(fn: (b: string) => T): T;
    declare function takesString(s: string): void;
    function run(): string do {
      use a <- withA();
      use b <- withB();
      b + a;
    }
    takesString(run());
  `);
  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /return withA\(a => \{/);
  assert.match(js, /return withB\(b => \{/);
  assert.match(js, /return b \+ a;/);
});

test("supports destructuring in a use binding", () => {
  const result = compile(`
    declare function withPair<T>(fn: (pair: [number, string]) => T): T;
    declare function takesNumber(n: number): void;
    declare function takesString(s: string): void;
    const res = do {
      use [num, str] <- withPair();
      takesNumber(num);
      takesString(str);
      num;
    };
    takesNumber(res);
  `);
  assert.deepEqual(result.messages, []);
  const js = result.javascript();
  assert.match(js, /return withPair\(\(\[num, str\]\) => \{/);
  assert.match(js, /return num;/);
});

test("offers quick info and completions for use bindings", () => {
  const source = `
    declare function withResource<T>(fn: (res: string) => T): T;
    const val = do {
      use r <- withResource();
      r;
    };
  `;
  const service = createLanguageService("/main.tspp", source);
  const quickInfo = service.getQuickInfoAtPosition("/main.tspp", source.indexOf("use r") + 4);
  assert.ok(quickInfo);
  assert.equal(quickInfo.displayParts?.map(part => part.text).join(""), "(const) r: string");
  // An ambient callee and a continuation typed as a function must not leak neighbouring source into the hover.
  const nested = source.replace("(fn: (res: string) => T)", "(fn: (res: (code: number) => string) => T)");
  const nestedInfo = createLanguageService("/main.tspp", nested).getQuickInfoAtPosition("/main.tspp", nested.indexOf("use r") + 4);
  assert.equal(nestedInfo?.displayParts?.map(part => part.text).join(""), "(const) r: (code: number) => string");
  const completions = service.getCompletionsAtPosition("/main.tspp", source.indexOf("r;"), {});
  assert.ok(completions?.entries.some(entry => entry.name === "r"));

  const defSource = `def appConfig = { network: { port: 8080 } }; console.log(appConfig.network.port);`;
  const defService = createLanguageService("/main.tspp", defSource);
  const defInfo = defService.getQuickInfoAtPosition("/main.tspp", defSource.indexOf("appConfig"));
  assert.match(defInfo?.displayParts?.map(part => part.text).join("") ?? "", /^def appConfig:\s*\{/);
  const defUsageInfo = defService.getQuickInfoAtPosition("/main.tspp", defSource.lastIndexOf("appConfig"));
  assert.match(defUsageInfo?.displayParts?.map(part => part.text).join("") ?? "", /^def appConfig:\s*\{/);
});

test("checks trailing closure results and the block completion type through use bindings", () => {
  const pipeline = withResource => `
    declare function withResource<T>(fn: (res: { name: string; close: () => void }) => T): T;
    declare function withAuth<T>(role: string, fn: (token: string) => T): T;
    declare function withPair<T>(fn: (pair: [number, string]) => T): T;
    function runPipeline(): string do {
      use token <- withAuth("admin");
      use [code, status] <- withPair();
      use res <- ${withResource};
      \`\${res.name}: [\${code}] \${status} for \${token}\`;
    }
  `;
  const invalid = compile(pipeline("withResource<number>()")).messages;
  assert.ok(invalid.some(message => message.includes("Type 'string' is not assignable to type 'number'")), invalid.join("\n"));
  assert.ok(invalid.some(message => message.includes("Type 'number' is not assignable to type 'string'")), invalid.join("\n"));
  assert.deepEqual(compile(pipeline("withResource()")).messages, []);
});

test("signature help on a use binding cut off at its call does not throw", () => {
  // As while the binding is typed: the call has no arguments or closing parenthesis yet.
  const source = `function withValue<T>(value: number, continuation: (value: number) => T): T { return continuation(value); }
const continued: number = do {
  use value: number <- withValue(`;
  const service = createLanguageService("/main.tspp", source);
  assert.doesNotThrow(() => service.getSignatureHelpItems("/main.tspp", source.length, undefined));
});
