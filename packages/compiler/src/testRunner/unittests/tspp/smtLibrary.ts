import * as macroFacade from "../../../compiler/macroFacade.js";
import * as smt from "../../../compiler/smtLibrary.js";
import {
  verificationApplication,
  verificationConstant,
  verificationInteger,
} from "../../../compiler/verificationIR.js";
import { readLogicFunction } from "../../../compiler/verificationLogicLibrary.js";
import { encodeVerificationProblem } from "../../../compiler/verificationSmt.js";
import { runVerificationQueries } from "../../../compiler/verificationWorker.js";
import * as ts from "../../_namespaces/ts.js";

describe("unittests:: tspp:: smt library", () => {
  const isMultipleOf = smt.definePredicate(
    "isMultipleOf",
    [["value", smt.Int], ["factor", smt.Int]],
    (value, factor) => smt.and(smt.not(smt.eq(factor, 0n)), smt.eq(smt.js.rem(value, factor), 0n)),
  );

  function definitionOf(fn: smt.LogicFunction<any, any>) {
    const read = readLogicFunction(fn, "test");
    if (typeof read === "string") throw new Error(read);
    return read;
  }

  async function prove(functions: readonly import("../../../compiler/verificationIR.js").VerificationFunction[], goal: import("../../../compiler/verificationIR.js").VerificationExpression, declarations: { name: string; sort: "Int"; }[] = []) {
    const encoding = encodeVerificationProblem({ functions, declarations, assertions: [], goal });
    return { encoding, result: (await runVerificationQueries([encoding.query]))[0] };
  }

  it("builds a define-fun whose body uses JavaScript remainder semantics", async () => {
    const { function: definition, functions } = definitionOf(isMultipleOf);
    assert.equal(definition.name, "isMultipleOf");
    assert.deepEqual(definition.parameters, [{ name: "value", sort: "Int" }, { name: "factor", sort: "Int" }]);
    assert.deepEqual(functions.map(item => item.name), ["isMultipleOf", "tspp.js.trunc.rem"]);
    const { encoding, result } = await prove(functions, verificationApplication("isMultipleOf", verificationInteger("-6"), verificationInteger("3")));
    assert.include(encoding.solverInput, "(define-fun isMultipleOf ((value Int) (factor Int)) Bool (and (not (= factor 0)) (= (tspp.js.trunc.rem value factor) 0)))");
    assert.equal(result.status, "proved");
  });

  it("checks sorts where a term is written", () => {
    assert.throws(() => smt.add(1n, smt.real(1.5) as never), "one numeric sort");
    assert.throws(() => smt.and(smt.int(1) as never), "Bool");
    assert.throws(() => smt.apply(isMultipleOf, 1n, smt.real(2) as never), "expects (Int Int)");
    assert.throws(() => smt.definePredicate("bad", [["x", smt.Int]], x => smt.add(x, 1n) as never), "expected Bool");
    assert.throws(() => smt.int(2 ** 60), "not a safe integer");
    assert.throws(() => smt.real(1e21), "decimal string");
  });

  it("rejects reserved and invalid names", () => {
    assert.throws(() => smt.definePredicate("tspp.mine", [], () => true), "reserved");
    assert.throws(() => smt.definePredicate("and", [], () => true), "shadow");
    assert.throws(() => smt.definePredicate("has space", [], () => true), "not a valid function name");
    assert.throws(() => smt.definePredicate("dup", [["x", smt.Int], ["x", smt.Int]], () => true), "declared twice");
    const other = smt.definePredicate("isMultipleOf", [["value", smt.Int]], () => true);
    assert.throws(() => smt.and(smt.apply(isMultipleOf, 1n, 1n), smt.apply(other, 1n)), "Two different logic functions");
  });

  it("is not executable at runtime", () => {
    assert.throws(() => (isMultipleOf as unknown as (a: bigint, b: bigint) => boolean)(6n, 3n), "can only be used in formal verification specifications");
  });

  it("defines recursive functions as trusted define-fun-rec", async () => {
    const triangular = smt.defineRecursiveFunction("triangular", [["n", smt.Int]], smt.Int, (self, n) => smt.ite(smt.le(n, 0n), 0n, smt.add(n, smt.apply(self, smt.sub(n, 1n)))));
    const { function: definition, functions } = definitionOf(triangular);
    assert.isTrue(definition.recursive);
    assert.deepEqual(functions.map(item => item.name), ["triangular"]);
    const { encoding, result } = await prove(functions, verificationApplication("=", verificationApplication("triangular", verificationInteger("4")), verificationInteger("10")));
    assert.include(encoding.solverInput, "(define-fun-rec triangular ((n Int)) Int (ite (<= n 0) 0 (+ n (triangular (- n 1)))))");
    // define-fun-rec is a quantified definition: the logic must allow quantifiers and UF.
    assert.include(encoding.solverInput, "(set-logic UFLIA)");
    assert.equal(result.status, "proved");
    assert.deepEqual(result.trustedInputs, ["recursive definition triangular (recursive logic function triangular (ts-plus-plus/smt))"]);
  });

  it("declares uninterpreted functions whose axioms are reported when used", async () => {
    const Item = smt.declareSort("Item");
    const weight = smt.declareFunction("weight", [["item", Item]], smt.Int, {
      axioms: self => [smt.axiom("weights are non-negative", smt.forall([["item", Item]], item => smt.ge(smt.apply(self, item), 0n), { patterns: item => [[smt.apply(self, item)]] }))],
    });
    const heavier = smt.definePredicate("heavier", [["a", Item], ["b", Item]], (a, b) => smt.gt(smt.apply(weight, a), smt.apply(weight, b)));
    const { functions } = definitionOf(heavier);
    assert.deepEqual(functions.map(item => item.name).sort(), ["heavier", "weight"]);
    const box = verificationConstant("box", { kind: "uninterpreted", name: "Item" });
    const encoding = encodeVerificationProblem({
      functions,
      declarations: [{ name: "box", sort: { kind: "uninterpreted", name: "Item" } }],
      assertions: [],
      goal: verificationApplication(">=", verificationApplication("weight", box), verificationInteger("0")),
    });
    assert.include(encoding.solverInput, "(declare-fun weight (Item) Int)");
    assert.include(encoding.solverInput, "; [axiom, trusted] weights are non-negative (axiom of weight)");
    const [result] = await runVerificationQueries([encoding.query]);
    assert.equal(result.status, "proved");
    assert.deepEqual(result.trustedInputs, ["weights are non-negative (axiom of weight)"]);
  });

  it("supports quantifiers and raw SMT-LIB", async () => {
    const square = smt.defineFunction("square", [["x", smt.Int]], smt.Int, x => smt.mul(x, x));
    const nonNegative = smt.forall([["x", smt.Int]], x => smt.ge(smt.apply(square, x), 0n));
    const viaRaw = smt.raw<boolean>("(>= (square 3) 9)", smt.Bool, [square]);
    const both = smt.definePredicate("squaresAreNonNegative", [], () => smt.and(nonNegative, viaRaw));
    const { functions } = definitionOf(both);
    const { encoding, result } = await prove(functions, verificationApplication("squaresAreNonNegative"));
    assert.include(encoding.solverInput, "(forall ((x Int)) (>= (square x) 0))");
    assert.include(encoding.solverInput, "(set-logic ALL)");
    assert.equal(result.status, "proved");
  });

  it("keeps raw SMT-LIB inside a single term boundary", () => {
    assert.throws(() => smt.raw("", smt.Bool), "text is empty");
    assert.throws(() => smt.raw("(check-sat)", smt.Bool), "solver command");
    assert.throws(() => smt.raw("true) (assert false", smt.Bool), "more than one top-level expression");
    assert.throws(() => smt.raw("(>= 1 0) (assert false)", smt.Bool), "more than one top-level expression");
    assert.throws(() => smt.raw("true ; swallow generated delimiters", smt.Bool), "trailing line comment");
    assert.doesNotThrow(() => smt.raw('; explanation\n(= |name with spaces| "a""b") ; done\n', smt.Bool));
  });

  describe("reading untrusted definitions", () => {
    const valid = isMultipleOf["tspp.logic.definition"];
    const read = (definition: unknown) => readLogicFunction({ "tspp.logic.definition": definition }, "lib");

    it("accepts what the library produces and copies it", () => {
      const result = read(valid);
      assert.notTypeOf(result, "string");
      assert.notStrictEqual((result as { function: unknown; }).function, valid.function);
    });

    it("rejects malformed or unsupported definitions with a reason", () => {
      assert.include(readLogicFunction(42, "lib") as string, "not a logic function");
      assert.include(read({ ...valid, version: 99 }) as string, "format 99");
      assert.include(read({ ...valid, function: { ...valid.function, body: { kind: "constant", name: "v0", sort: "Int" } } }) as string, "term kind 'constant' is not allowed");
      assert.include(read({ ...valid, function: { ...valid.function, sort: { kind: "sum", name: "S", variants: [] } } }) as string, "a sort must be");
      assert.include(read({ ...valid, function: { ...valid.function, name: "tspp.std.isEven.Int" } }) as string, "reserved");
      assert.include(read({ ...valid, function: { ...valid.function, body: { kind: "integer", value: "1; (assert false)" } } }) as string, "not a valid numeral");
      assert.include(read({ ...valid, function: { ...valid.function, body: { kind: "raw", text: "true) (assert false", sort: "Bool", symbols: [] } } }) as string, "exactly one term");
      let deep: unknown = { kind: "boolean", value: true };
      for (let i = 0; i < 300; i++) deep = { kind: "application", symbol: "not", operands: [deep] };
      assert.include(read({ ...valid, function: { ...valid.function, body: deep } }) as string, "nests deeper");
    });
  });
});

describe("unittests:: tspp:: macro facade", () => {
  it("exports the documented SDK, bound to the running compiler", () => {
    assert.equal(macroFacade.macroApiVersion, 1);
    assert.equal(macroFacade.SyntaxKind.ExportKeyword, ts.SyntaxKind.ExportKeyword);
    assert.strictEqual(macroFacade.isFunctionDeclaration, ts.isFunctionDeclaration);
    assert.deepEqual(Object.keys(macroFacade).sort(), [
      "DiagnosticCategory",
      "NodeFlags",
      "SyntaxKind",
      "forEachChild",
      "idText",
      "isArrayLiteralExpression",
      "isArrowFunction",
      "isBlock",
      "isCallExpression",
      "isClassDeclaration",
      "isDataDeclaration",
      "isDataVariant",
      "isEnumDeclaration",
      "isExportDeclaration",
      "isExpressionStatement",
      "isFunctionDeclaration",
      "isFunctionExpression",
      "isIdentifier",
      "isImportDeclaration",
      "isInterfaceDeclaration",
      "isMacroInvocationStatement",
      "isMethodDeclaration",
      "isMethodSignature",
      "isNewtypeDeclaration",
      "isNumericLiteral",
      "isObjectLiteralExpression",
      "isParameter",
      "isPropertyAccessExpression",
      "isPropertyDeclaration",
      "isPropertySignature",
      "isReturnStatement",
      "isStringLiteral",
      "isTypeAliasDeclaration",
      "isTypeLiteralNode",
      "isTypeReferenceNode",
      "isVariableDeclaration",
      "isVariableStatement",
      "macroApiVersion",
    ]);
  });

  it("is served by the compiler to the macros it runs", () => {
    const fileName = "/file.tspp";
    const content = `
      import * as macros from "ts-plus-plus/macros";
      macro function exposeVersion(targets, context) {
        if (!macros.isInterfaceDeclaration(targets[0].node)) return context.fail("expected an interface");
        return context.factory.createVariableStatement(
          [context.factory.createModifier(macros.SyntaxKind.ExportKeyword)],
          context.factory.createVariableDeclarationList(
            [context.factory.createVariableDeclaration("apiVersion", undefined, undefined, context.factory.createNumericLiteral(macros.macroApiVersion))],
            macros.NodeFlags.Const,
          ),
        );
      }
      interface User { id: number }
      macro exposeVersion(User);
    `;
    const options: ts.CompilerOptions = { noLib: true, noImplicitAny: false, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, tsppFeatures: ["macros"] };
    const host = ts.createCompilerHost(options);
    const files = new Map([[fileName, content]]);
    host.fileExists = name => files.has(name);
    host.readFile = name => files.get(name);
    host.getSourceFile = (name, languageVersion) => files.has(name) ? ts.createSourceFile(name, files.get(name)!, languageVersion) : undefined;
    host.writeFile = () => {};
    const program = ts.createProgram({ host, rootNames: [fileName], options });
    const expansions = program.getMacroExpansions!();
    assert.lengthOf(expansions, 1);
    assert.include(expansions[0].text, "export const apiVersion = 1;");
  });
});
