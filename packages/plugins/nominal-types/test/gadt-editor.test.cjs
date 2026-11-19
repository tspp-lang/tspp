const assert = require("node:assert/strict");
const { test } = require("node:test");
const { ts, usePlugins, createLanguageService, formatDocument, withoutIndentation, diagnosticMessages } = require("../../test-support/compile.cjs");
const { nominalTypesPlugin, nominalTypesADTAPI } = require("../dist");

usePlugins(nominalTypesPlugin);

test("the ADT API reads brace signatures, comments, nested types, and following declarations", () => {
  const declarations = nominalTypesADTAPI.getDataTypes(`
    // data Fake { Hidden: Fake }
    data Expr<T extends "int" | "bool"> {
      // punctuation in literals must not close the declaration
      Val: (value: { label: "},|"; fn: (input: string) => number }) => Expr<"int">,
      Wrap: <A extends "int" | "bool">(value: Expr<A>) => Expr<A>,
      Empty: Expr<"bool">,
    }
    data Token { New: () => Token, Zero: Token }
    data Legacy = Done;
  `);
  assert.deepEqual(declarations.map(declaration => declaration.name), ["Expr", "Token", "Legacy"]);
  assert.deepEqual(declarations[0].typeParameters, ["T"]);
  const [value, wrap, empty] = declarations[0].variants;
  assert.equal(value.fields[0].type, '{ label: "},|"; fn: (input: string) => number }');
  assert.equal(value.resultType, 'Expr<"int">');
  assert.deepEqual(wrap.typeParameters, ['A extends "int" | "bool"']);
  assert.equal(empty.callable, false);
  assert.equal(declarations[1].variants[0].callable, true);
  assert.equal(declarations[1].variants[1].callable, false);
});

test("hover shows brace constructor signatures without adding data indices as constructor generics", () => {
  const source = `data Expr<T> {
    Val: (value: bigint) => Expr<bigint>,
    Wrap: <A>(value: Expr<A>) => Expr<A>,
    Empty: Expr<never>,
  }
  data Token { New: () => Token }
  const value = Val(42n);
  const token = New();
  `;
  const service = createLanguageService("/main.tspp", source);
  const display = name => ts.displayPartsToString(service.getQuickInfoAtPosition("/main.tspp", source.lastIndexOf(name))?.displayParts);
  assert.equal(display("Val"), "(data constructor) Val(value: bigint): Expr<bigint>");
  assert.equal(display("New"), "(data constructor) New(): Token");
  assert.deepEqual(diagnosticMessages(service.getProgram()), []);
});

test("formatting preserves and restores brace declaration layout", () => {
  const source = `data Expr<T> {
    Val: (value: bigint) => Expr<bigint>,
    Wrap: <A>(value: Expr<A>) => Expr<A>,
    Empty: Expr<never>,
}
`;
  assert.equal(formatDocument(source), source);
  assert.equal(formatDocument(withoutIndentation(source)), source);
});
