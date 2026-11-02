// End-to-end behavior of runtime reification: `reify T` and expression-level `typecase` lower to ordinary
// TypeScript while parsing, the checker selects a `typecase` arm, and emit keeps only that arm.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");
const { typeComputationPlugin } = require("../dist");

usePlugins(typeComputationPlugin);

const options = { noLib: false, lib: ["lib.es2022.d.ts"], declaration: true };

function compile(source, extra = {}) {
  const { program, outputs } = createProgram({ "/main.tspp": source }, { ...options, ...extra });
  const messages = diagnosticMessages(program);
  const javascript = emitJavaScript(program, outputs);
  const declarations = [...outputs].filter(([fileName]) => fileName.endsWith(".d.ts")).map(([, text]) => text).join("\n");
  return { messages, javascript, declarations };
}

test("reify produces a serializable descriptor whose type carries the represented type", () => {
  const { messages, javascript, declarations } = compile(`
    export const text = reify string;
    export const list = reify Array<  string >;
    export const kind: "type" = text.kind;
    export const represented: string[] = null! as typeof list.__tspp_reified_type;
  `);
  assert.deepEqual(messages, []);
  assert.match(javascript, /exports\.text = \{ kind: "type", text: "string" \};/);
  assert.match(javascript, /exports\.list = \{ kind: "type", text: "Array<string>" \};/);
  assert.match(declarations, /__tspp_reified_type: Array<string>;/);
});

test("typecase selects the first arm whose pattern accepts the described type and emits only that arm", () => {
  const { messages, javascript, declarations } = compile(`
    declare function effect(): void;
    const text = reify string;
    const literal = reify "a";
    export const selected = typecase (effect(), text) { number => 1, string => "text", _ => false };
    export const accepted = typecase literal { string => "string", _ => "fallback" };
    export const fallback = typecase reify boolean { number => 1, string => "text", _ => false };
  `);
  assert.deepEqual(messages, []);
  assert.match(javascript, /exports\.selected = "text";/);
  assert.match(javascript, /exports\.accepted = "string";/);
  assert.match(javascript, /exports\.fallback = false;/);
  // Neither the scrutinee nor the other arms run.
  assert.doesNotMatch(javascript, /effect\(\)|_tspp|__tspp/);
  assert.match(declarations, /selected: string;/);
  assert.match(declarations, /fallback: boolean;/);
});

test("infer captures become type parameters of their arm", () => {
  const { messages, javascript, declarations } = compile(`
    const pairs = reify Map<string, number[]>;
    export const values = typecase pairs {
      Map<infer K, infer V> => [] as [K, V][],
      _ => null
    };
    export const first: [string, number[]] | undefined = values[0];
  `);
  assert.deepEqual(messages, []);
  assert.match(javascript, /exports\.values = \[\];/);
  assert.match(declarations, /values: \[string, number\[\]\]\[\];/);
});

test("a scrutinee that is not a descriptor selects the wildcard arm", () => {
  const { messages, javascript } = compile(`
    declare const plain: { kind: "type"; text: string };
    export const chosen = typecase plain { string => 1, _ => "wildcard" };
  `);
  assert.deepEqual(messages, []);
  assert.match(javascript, /exports\.chosen = "wildcard";/);
});

test("arms are checked even when they are not selected", () => {
  const { messages } = compile(`
    export const chosen = typecase reify string { string => 1, number => missing, Missing => 2, _ => 0 };
  `);
  assert.deepEqual(messages, ["Cannot find name 'missing'.", "Cannot find name 'Missing'."]);
});

test("unused-declaration checks see no generated names", () => {
  const { messages } = compile(`
    export const chosen = typecase reify string { Array<infer E> => 1, string => 2, _ => 0 };
  `, { noUnusedLocals: true, noUnusedParameters: true });
  assert.deepEqual(messages, []);
});

test("typecase requires a final '_' arm", () => {
  assert.match(compile("export const a = typecase reify string { string => 1 };").messages.join("\n"), /must end with an '_' arm/);
  assert.match(compile("export const a = typecase reify string { _ => 1, string => 2, _ => 3 };").messages.join("\n"), /'_' arm must be the last arm/);
});

test("reify and typecase remain ordinary identifiers elsewhere", () => {
  const { messages, javascript } = compile(`
    const reify = 1, typecase = 2;
    export const sum = reify + typecase;
    export const called = [reify].map(typecase => typecase)[0];
  `);
  assert.deepEqual(messages, []);
  assert.match(javascript, /exports\.sum = reify \+ typecase;/);
});

test("editors see the authored captures and no generated parameters", () => {
  const source = `const list = reify Array<string>;
export const values = typecase list {
  Array<infer Element> => [] as Element[],
  _ => []
};
`;
  const service = createLanguageService("/main.tspp", source);
  const capture = source.indexOf("Element");
  const quickInfo = service.getQuickInfoAtPosition("/main.tspp", source.lastIndexOf("Element"));
  assert.match(ts.displayPartsToString(quickInfo.displayParts), /^\(type parameter\) Element/);
  const references = service.findReferences("/main.tspp", capture)[0].references.map(reference => reference.textSpan.start);
  assert.deepEqual(references, [capture, source.lastIndexOf("Element")]);
  const hints = service.provideInlayHints("/main.tspp", { start: 0, length: source.length }, {
    includeInlayParameterNameHints: "all",
    includeInlayFunctionParameterTypeHints: true,
    includeInlayFunctionLikeReturnTypeHints: true,
  });
  assert.deepEqual(hints, []);
});
