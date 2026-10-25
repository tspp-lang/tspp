import {
  verificationApplication,
  verificationAssertion,
  verificationBoolean,
  verificationConstant,
  verificationConstruct,
  VerificationExpression,
  VerificationFunction,
  verificationInteger,
  verificationIsVariant,
  verificationLet,
  verificationQuantifier,
  verificationRaw,
  verificationReal,
  verificationSelect,
  verificationString,
  VerificationSumSort,
  VerificationUninterpretedSort,
  verificationVariable,
} from "../../../compiler/verificationIR.js";
import { lowerArithmetic } from "../../../compiler/verificationProgramSemantics.js";
import {
  createVerificationLogicFeatures,
  getVerificationLogic,
} from "../../../compiler/verificationSignatures.js";
import { encodeVerificationProblem } from "../../../compiler/verificationSmt.js";
import { interpretVerificationResponse } from "../../../compiler/verificationSmtResponse.js";
import {
  clearVerificationCache,
  getVerificationCacheStats,
  runVerificationQueries,
} from "../../../compiler/verificationWorker.js";

describe("unittests:: tspp:: verification IR", () => {
  it("encodes closed sum sorts as SMT datatypes", async () => {
    const resultSort: VerificationSumSort = {
      kind: "sum",
      name: "Result",
      variants: [
        { name: "Success", fields: [{ name: "value", sort: "Int" }] },
        { name: "Failure", fields: [{ name: "code", sort: "Int" }] },
      ],
    };
    const result = verificationConstant("result", resultSort);
    const isSuccess = verificationIsVariant(result, resultSort, "Success");
    const successValue = verificationSelect(result, resultSort, "value", "Success");
    const problem = {
      declarations: [{ name: "result", sort: resultSort, sourceName: "result" }],
      assertions: [verificationAssertion(isSuccess, "path"), verificationAssertion(verificationApplication(">=", successValue, verificationInteger("0")), "path")],
      goal: isSuccess,
    };
    const encoding = encodeVerificationProblem(problem);

    assert.include(encoding.solverInput, "(declare-datatypes");
    assert.include(encoding.solverInput, "tspp.ctor");
    assert.include(encoding.solverInput, "((_ is");
    assert.include(encoding.solverInput, "tspp.field");
    assert.equal((await runVerificationQueries([encoding.query]))[0].status, "proved");
  });

  it("rejects malformed structured sorts before invoking Z3", () => {
    const malformed: VerificationSumSort = {
      kind: "sum",
      name: "Duplicate",
      variants: [
        { name: "Same", fields: [] },
        { name: "Same", fields: [] },
      ],
    };
    assert.throws(() => encodeVerificationProblem({ declarations: [{ name: "value", sort: malformed }], assertions: [], goal: verificationApplication("=", verificationInteger("0"), verificationInteger("0")) }), "Duplicate variant");
  });

  it("encodes recursive datatypes", async () => {
    const list = { kind: "sum", name: "List", variants: [] } as unknown as VerificationSumSort;
    (list as { variants: VerificationSumSort["variants"]; }).variants = [
      { name: "Nil", fields: [] },
      { name: "Cons", fields: [{ name: "head", sort: "Int" }, { name: "tail", sort: list }] },
    ];
    const value = verificationConstant("value", list);
    const encoding = encodeVerificationProblem({
      declarations: [{ name: "value", sort: list, sourceName: "value" }],
      assertions: [],
      goal: verificationApplication("or", verificationIsVariant(value, list, "Nil"), verificationIsVariant(value, list, "Cons")),
    });
    assert.equal((await runVerificationQueries([encoding.query]))[0].status, "proved");
  });

  it("reuses content-addressed verification results", async () => {
    clearVerificationCache();
    const input = encodeVerificationProblem({
      declarations: [],
      assertions: [],
      goal: verificationApplication("=", verificationInteger("1"), verificationInteger("1")),
    }).query;
    await runVerificationQueries([input]);
    await runVerificationQueries([input]);
    assert.deepEqual(getVerificationCacheStats(), { hits: 1, misses: 1, size: 1 });
  });

  it("cancels an active solver worker", async () => {
    clearVerificationCache();
    let cancelled = false;
    const token = {
      isCancellationRequested: () => cancelled,
      throwIfCancellationRequested: () => {
        if (cancelled) throw new Error("cancelled");
      },
    };
    const input = encodeVerificationProblem({
      declarations: [],
      assertions: [],
      goal: verificationApplication("=", verificationInteger("2"), verificationInteger("2")),
    }).query;
    const pending = runVerificationQueries([input], /*budget*/ undefined, token);
    cancelled = true;
    const [result] = await pending;
    assert.equal(result.reason?.code, "cancelled");
  });

  it("reports solver worker timeouts distinctly", async () => {
    clearVerificationCache();
    const input = encodeVerificationProblem({
      declarations: [],
      assertions: [],
      goal: verificationApplication("=", verificationInteger("3"), verificationInteger("3")),
    }).query;
    const [result] = await runVerificationQueries([input], { minimumTimeoutMs: 1, timeoutPerQueryMs: 1, maxOldGenerationSizeMb: 256 });
    assert.equal(result.reason?.code, "timeout");
  });

  describe("SMT IR", () => {
    const x = verificationConstant("x", "Int");
    const y = verificationConstant("y", "Int");
    const intDeclarations = [{ name: "x", sort: "Int" as const }, { name: "y", sort: "Int" as const }];

    it("prints standard SMT-LIB without solver-specific options or commands", () => {
      const { solverInput, replayableSmtLib } = encodeVerificationProblem({
        declarations: intDeclarations,
        assertions: [verificationAssertion(verificationApplication(">", x, y), "precondition", "requires: x > y")],
        goal: verificationApplication(">=", x, y),
      });
      assert.notInclude(solverInput, ":timeout");
      assert.notInclude(solverInput, "(check-sat)");
      assert.notInclude(solverInput, "tspp-model");
      assert.include(solverInput, "(set-option :produce-models true)");
      assert.include(solverInput, "(set-logic QF_LIA)");
      assert.include(solverInput, "; [precondition] requires: x > y\n(assert (> x y))");
      assert.include(replayableSmtLib, "(check-sat)");
    });

    it("classifies problems into the smallest standard logic", () => {
      const logic = (features: Partial<ReturnType<typeof createVerificationLogicFeatures>>) => getVerificationLogic({ ...createVerificationLogicFeatures(), ...features });
      assert.equal(logic({}), "QF_UF");
      assert.equal(logic({ ints: true }), "QF_LIA");
      assert.equal(logic({ ints: true, nonlinear: true }), "QF_NIA");
      assert.equal(logic({ ints: true, reals: true }), "QF_LIRA");
      assert.equal(logic({ reals: true, uninterpretedFunctions: true }), "QF_UFLRA");
      assert.equal(logic({ strings: true, ints: true }), "QF_SLIA");
      assert.equal(logic({ ints: true, quantifiers: true }), "LIA");
      // There is no QF_DTLIA logic, so the next wider standard logic is used.
      assert.equal(logic({ datatypes: true, ints: true }), "UFDTLIA");
      assert.equal(logic({ datatypes: true, strings: true }), "ALL");
      assert.equal(logic({ ints: true, raw: true }), "ALL");
    });

    it("infers the logic from the terms of a problem", () => {
      const nonlinear = encodeVerificationProblem({ declarations: intDeclarations, assertions: [], goal: verificationApplication(">=", verificationApplication("*", x, x), verificationInteger("0")) });
      assert.include(nonlinear.solverInput, "(set-logic QF_NIA)");
      const linear = encodeVerificationProblem({ declarations: intDeclarations, assertions: [], goal: verificationApplication(">=", verificationApplication("*", verificationInteger("2"), x), x) });
      assert.include(linear.solverInput, "(set-logic QF_LIA)");
    });

    it("rejects ill-sorted terms and symbols outside the standard theories", () => {
      const encode = (goal: VerificationExpression) => encodeVerificationProblem({ declarations: intDeclarations, assertions: [], goal });
      assert.throws(() => encode(verificationApplication("=", x, verificationReal("1"))), "one sort");
      assert.throws(() => encode(verificationApplication("+", x, verificationBoolean(/*value*/ true))), "numeric");
      assert.throws(() => encode(verificationApplication("str.to.int", verificationString("1"))), "neither a standard SMT-LIB theory symbol");
      assert.throws(() => encode(verificationApplication("+", x, y)), "must have sort Bool");
      assert.throws(() => encode(verificationApplication("=", verificationConstant("z", "Int"), x)), "not declared");
      assert.throws(() => encode(verificationApplication("=", verificationVariable("unbound", "Int"), x)), "not bound");
    });

    it("prints only the reachable definitions, after the definitions they use", async () => {
      const value = verificationVariable("value", "Int");
      const isPositive: VerificationFunction = { name: "user.isPositive", parameters: [{ name: "value", sort: "Int" }], sort: "Bool", body: verificationApplication(">", value, verificationInteger("0")), origin: "test positive" };
      const isLarge: VerificationFunction = { name: "user.isLarge", parameters: [{ name: "value", sort: "Int" }], sort: "Bool", body: verificationApplication("and", verificationApplication("user.isPositive", value), verificationApplication(">", value, verificationInteger("100"))), origin: "test large" };
      const unused: VerificationFunction = { name: "user.unused", parameters: [], sort: "Int", origin: "test unused" };
      const encoding = encodeVerificationProblem({
        functions: [isLarge, isPositive, unused],
        declarations: intDeclarations,
        assertions: [verificationAssertion(verificationApplication("user.isLarge", x), "precondition")],
        goal: verificationApplication("user.isPositive", x),
      });
      const script = encoding.solverInput;
      assert.include(script, "; test positive\n(define-fun user.isPositive ((value Int)) Bool (> value 0))");
      assert.isBelow(script.indexOf("(define-fun user.isPositive"), script.indexOf("(define-fun user.isLarge"));
      assert.notInclude(script, "user.unused");
      // Non-recursive definitions are conservative: nothing is reported as trusted.
      const [result] = await runVerificationQueries([encoding.query]);
      assert.equal(result.status, "proved");
      assert.isUndefined(result.trustedInputs);
    });

    it("rejects definition cycles and reports recursive definitions as trusted", () => {
      const n = verificationVariable("n", "Int");
      const loop: VerificationFunction = { name: "user.loop", parameters: [{ name: "n", sort: "Int" }], sort: "Int", body: verificationApplication("+", verificationApplication("user.loop", n), verificationInteger("1")), origin: "test loop" };
      const problem = { functions: [loop], declarations: intDeclarations, assertions: [], goal: verificationApplication("=", verificationApplication("user.loop", x), x) };
      assert.throws(() => encodeVerificationProblem(problem), "definition cycle");
      const recursive = encodeVerificationProblem({ ...problem, functions: [{ ...loop, recursive: true }] });
      assert.include(recursive.solverInput, "(define-fun-rec user.loop");
      assert.include(recursive.query.modelAssumptions.join(), "recursive definition user.loop (test loop)");
    });

    it("encodes uninterpreted sorts, declared functions, and quantified axioms", async () => {
      const item: VerificationUninterpretedSort = { kind: "uninterpreted", name: "Item" };
      const weight: VerificationFunction = { name: "weight", parameters: [{ name: "item", sort: item }], sort: "Int", origin: "test weight" };
      const anyItem = verificationVariable("item", item);
      const nonNegative = verificationQuantifier(
        "forall",
        [{ name: "item", sort: item }],
        verificationApplication(">=", verificationApplication("weight", anyItem), verificationInteger("0")),
        [[verificationApplication("weight", anyItem)]],
      );
      const box = verificationConstant("box", item);
      const encoding = encodeVerificationProblem({
        functions: [weight],
        declarations: [{ name: "box", sort: item, sourceName: "box" }],
        assertions: [verificationAssertion(nonNegative, "axiom", "weights are non-negative")],
        goal: verificationApplication(">", verificationApplication("+", verificationApplication("weight", box), verificationInteger("1")), verificationInteger("0")),
      });
      const script = encoding.solverInput;
      assert.include(script, "(declare-sort Item 0)");
      assert.include(script, "(declare-fun weight (Item) Int)");
      assert.include(script, "(forall ((item Item)) (! (>= (weight item) 0) :pattern ((weight item))))");
      assert.include(script, "(set-logic UFLIA)");
      assert.include(script, "; [axiom, trusted] weights are non-negative");
      const [result] = await runVerificationQueries([encoding.query]);
      assert.equal(result.status, "proved");
      assert.deepEqual(result.trustedInputs, ["weights are non-negative"]);
    });

    it("reports only the trusted inputs a proof depends on", async () => {
      const encoding = encodeVerificationProblem({
        declarations: intDeclarations,
        assertions: [
          verificationAssertion(verificationApplication(">", x, verificationInteger("10")), "assumption", "assume: x > 10"),
          verificationAssertion(verificationApplication(">", y, verificationInteger("10")), "assumption", "assume: y > 10"),
        ],
        goal: verificationApplication(">", x, verificationInteger("5")),
      });
      assert.include(encoding.solverInput, "(set-option :produce-unsat-cores true)");
      assert.include(encoding.solverInput, ":named tspp.trusted.0");
      const [result] = await runVerificationQueries([encoding.query]);
      assert.equal(result.status, "proved");
      assert.deepEqual(result.trustedInputs, ["assume: x > 10"]);
      assert.include(result.message, "relies on trusted input: assume: x > 10");
    });

    it("keeps raw SMT-LIB as an escape hatch that still resolves its symbols", async () => {
      const raw = verificationRaw("(>= (* x x) 0)", "Bool", ["x"]);
      const encoding = encodeVerificationProblem({ declarations: intDeclarations, assertions: [], goal: raw });
      assert.include(encoding.solverInput, "(set-logic ALL)");
      assert.include(encoding.solverInput, "(assert (not (>= (* x x) 0)))");
      assert.equal((await runVerificationQueries([encoding.query]))[0].status, "proved");
      assert.throws(() => encodeVerificationProblem({ declarations: [], assertions: [], goal: verificationRaw("(f 1)", "Bool", ["f"]) }), "undeclared symbol 'f'");
      assert.throws(() => encodeVerificationProblem({ declarations: [], assertions: [], goal: verificationRaw("(reset)", "Bool") }), "solver command");
      assert.throws(() => encodeVerificationProblem({ declarations: [], assertions: [], goal: verificationRaw("true) (assert false", "Bool") }), "exactly one term");
    });

    it("binds let variables in parallel and checks their sorts", async () => {
      const doubled = verificationVariable("doubled", "Int");
      const goal = verificationLet(
        [{ name: "doubled", value: verificationApplication("+", x, x) }],
        verificationApplication("=", doubled, verificationApplication("*", verificationInteger("2"), x)),
      );
      const encoding = encodeVerificationProblem({ declarations: intDeclarations, assertions: [], goal });
      assert.include(encoding.solverInput, "(assert (not (let ((doubled (+ x x))) (= doubled (* 2 x)))))");
      assert.equal((await runVerificationQueries([encoding.query]))[0].status, "proved");
      assert.throws(
        () => encodeVerificationProblem({ declarations: intDeclarations, assertions: [], goal: verificationLet([{ name: "flag", value: verificationBoolean(/*value*/ true) }], verificationApplication("=", verificationVariable("flag", "Int"), x)) }),
        "differs from its binding",
      );
    });

    it("encodes literals portably", () => {
      const r = verificationConstant("r", "Real");
      const s = verificationConstant("s", "String");
      const { solverInput } = encodeVerificationProblem({
        declarations: [{ name: "r", sort: "Real" }, { name: "s", sort: "String" }],
        assertions: [],
        goal: verificationApplication(
          "and",
          verificationApplication("=", r, verificationReal("3")),
          verificationApplication("=", r, verificationReal("-0.5")),
          verificationApplication("=", s, verificationString('say "hi" \\ π')),
        ),
      });
      // In a mixed logic a bare numeral is an Int, so Real literals always carry a decimal point.
      assert.include(solverInput, "(= r 3.0)");
      assert.include(solverInput, "(= r (- 0.5))");
      assert.include(solverInput, '(= s "say ""hi"" \\u{5c} \\u{3c0}")');
    });
  });

  describe("program semantics", () => {
    it("models JavaScript truncated division and remainder, not SMT div/mod", async () => {
      const values = [-7n, -6n, -3n, -1n, 0n, 1n, 3n, 6n, 7n];
      const divisors = [-3n, -2n, 2n, 3n];
      const literal = (value: bigint) => ({ sort: "Int" as const, expression: verificationInteger(String(value)) });
      const functions = new Map<string, VerificationFunction>();
      const facts: VerificationExpression[] = [];
      for (const a of values) {
        for (const b of divisors) {
          for (const [operator, expected] of [["/", a / b], ["%", a % b]] as const) {
            const lowered = lowerArithmetic(operator, literal(a), literal(b), "bigint", /*model*/ undefined, `${a}n ${operator} ${b}n`);
            if (typeof lowered === "string") throw new Error(lowered);
            assert.isEmpty(lowered.obligations, "a non-zero literal divisor needs no obligation");
            for (const definition of lowered.functions) functions.set(definition.name, definition);
            facts.push(verificationApplication("=", lowered.term.expression, verificationInteger(String(expected))));
          }
        }
      }
      const encoding = encodeVerificationProblem({ functions: [...functions.values()], declarations: [], assertions: [], goal: verificationApplication("and", ...facts) });
      assert.include(encoding.solverInput, "(define-fun tspp.js.trunc.rem");
      assert.include(encoding.solverInput, "(define-fun tspp.js.trunc.div");
      assert.equal((await runVerificationQueries([encoding.query]))[0].status, "proved");
    });

    it("requires a non-zero divisor and keeps the sign of the dividend", async () => {
      const a = { sort: "Int" as const, expression: verificationConstant("a", "Int") };
      const b = { sort: "Int" as const, expression: verificationConstant("b", "Int") };
      const lowered = lowerArithmetic("%", a, b, "bigint", /*model*/ undefined, "a % b");
      if (typeof lowered === "string") throw new Error(lowered);
      assert.deepEqual(lowered.obligations.map(obligation => obligation.obligation), ["nonzero-divisor"]);
      const remainder = lowered.term.expression;
      const encoding = encodeVerificationProblem({
        functions: lowered.functions,
        declarations: [{ name: "a", sort: "Int" }, { name: "b", sort: "Int" }],
        assertions: [verificationAssertion(lowered.obligations[0].goal, "assertion")],
        goal: verificationApplication(
          "and",
          verificationApplication("<", verificationApplication("abs", remainder), verificationApplication("abs", b.expression)),
          verificationApplication("or", verificationApplication("=", remainder, verificationInteger("0")), verificationApplication("=", verificationApplication(">=", remainder, verificationInteger("0")), verificationApplication(">=", a.expression, verificationInteger("0")))),
        ),
      });
      assert.equal((await runVerificationQueries([encoding.query]))[0].status, "proved");
    });

    it("rejects operations a number model cannot represent", () => {
      const one = { sort: "Int" as const, expression: verificationInteger("1") };
      const half = { sort: "Real" as const, expression: verificationReal("0.5") };
      assert.include(lowerArithmetic("/", one, one, "number", "safe-integer", "1 / 1") as string, "not integer division");
      assert.include(lowerArithmetic("%", half, half, "number", "mathematical-real", "0.5 % 0.5") as string, "outside the mathematical-real model");
      const sum = lowerArithmetic("+", one, one, "number", "safe-integer", "1 + 1");
      assert.deepEqual(typeof sum === "string" ? sum : sum.obligations.map(obligation => obligation.obligation), ["safe-integer-range"]);
    });
  });

  describe("solver responses", () => {
    it("formats get-value responses as source-level counterexamples", () => {
      const list = { kind: "sum", name: "List", variants: [] } as unknown as VerificationSumSort;
      (list as { variants: VerificationSumSort["variants"]; }).variants = [
        { name: "Nil", fields: [] },
        { name: "Cons", fields: [{ name: "head", sort: "Int" }, { name: "tail", sort: list }] },
      ];
      const { query } = encodeVerificationProblem({
        declarations: [
          { name: "v0", sort: "Int", sourceName: "count" },
          { name: "v1", sort: "Real", sourceName: "ratio" },
          { name: "v2", sort: "String", sourceName: "label" },
          { name: "v3", sort: list, sourceName: "items" },
        ],
        assertions: [],
        goal: verificationApplication("=", verificationConstant("v3", list), verificationConstruct(list, [], "Nil")),
      });
      const ctor = (variant: string) => query.sorts[0].variants.find(candidate => candidate.name === variant)!.constructor;
      const result = interpretVerificationResponse(query, {
        status: "sat",
        output: `((v0 (- 3))\n (v1 (/ 1.0 2.0))\n (v2 "a""b")\n (v3 (${ctor("Cons")} 2 (as ${ctor("Nil")} ${query.sorts[0].sort}))))`,
      });
      assert.equal(result.status, "failed");
      assert.equal(result.counterexample, 'count = -3, ratio = 1/2, label = "a\\"b", items = { _tag: "Cons", head: 2, tail: { _tag: "Nil" } }');
    });

    it("maps solver timeouts and errors to structured results", () => {
      const { query } = encodeVerificationProblem({ declarations: [], assertions: [], goal: verificationBoolean(/*value*/ true) });
      const timeout = interpretVerificationResponse(query, { status: "unknown", output: '(:reason-unknown "timeout")' });
      assert.equal(timeout.reason?.code, "timeout");
      assert.include(timeout.message, "unknown: timeout");
      const other = interpretVerificationResponse(query, { status: "unknown", output: "(:reason-unknown incomplete)" });
      assert.isUndefined(other.reason);
      assert.equal(interpretVerificationResponse(query, { status: "error", message: '(error "bad")' }).status, "error");
    });

    it("routes queries through a host solver that only speaks SMT-LIB", async () => {
      clearVerificationCache();
      const encoding = encodeVerificationProblem({
        declarations: [{ name: "x", sort: "Int", sourceName: "x" }],
        assertions: [],
        goal: verificationApplication(">", verificationConstant("x", "Int"), verificationInteger("0")),
      });
      const seen: { script: string; onSat?: string; }[] = [];
      const host = {
        solveVerificationQueries: async (requests: readonly { script: string; onSat?: string; }[]) => {
          seen.push(...requests);
          return requests.map(() => ({ status: "sat" as const, output: "((x 0))" }));
        },
      };
      const [result] = await runVerificationQueries([encoding.query], /*budget*/ undefined, /*cancellationToken*/ undefined, host as never);
      assert.equal(seen[0].script, encoding.solverInput);
      assert.equal(seen[0].onSat, "(get-value (x))");
      assert.equal(result.status, "failed");
      assert.equal(result.counterexample, "x = 0");
    });
  });
});
