const test = require("node:test");
const { expectVerification } = require("./analyze.cjs");

// Ported from the compiler-integrated verifier's unit tests on the legacy-monolith branch
// (src/testRunner/unittests/tspp/formalContracts.ts), restated against the plugin analyzer.
const cases = [
  {
    name: "sum loop",
    source: `function sum(n: bigint) with { requires: n >= 0n; ensures: result === n; }: bigint { let x = 0n; while (x < n) with { invariant: [x >= 0n, x <= n]; } { x += 1n; } return x; }`,
  },
  {
    name: "false postcondition",
    source: `function bad(x: bigint) with { ensures: result > x; }: bigint { return x; }`,
    rejects: /bad postcondition could not be proved\./,
  },
  {
    name: "assert proof point",
    source: `function increment(x: bigint) with { requires: x >= 0n; }: bigint { const next = x + 1n; assert: next > 0n; return next; }`,
  },
  {
    name: "false assert",
    source: `function positive(x: bigint): bigint { assert: x > 0n; return x; }`,
    rejects: /local assertion could not be proved\./,
  },
  {
    name: "result arithmetic",
    source: `function evenPlusTwo(n: bigint) with { requires: n % 2n === 0n; ensures: result % 2n === 0n; }: bigint { return n + 2n; }`,
  },
  {
    name: "loop invariant initialization fails",
    source: `function countTo(limit: bigint) with { ensures: result === limit; }: bigint { let current = 0n; while (current < limit) with { invariant: [current >= 0n, current <= limit]; } { current += 1n; } return current; }`,
    rejects: /loop invariant initialization could not be proved\./,
  },
  {
    name: "call violates requires",
    source: `function successor(value: bigint) with { requires: value >= 0n; }: bigint { return value + 1n; }
successor(-5n);`,
    rejects: /successor call precondition could not be proved\./,
  },
  {
    name: "array requires at call",
    source: `function bounded(value: bigint) with { requires: [value >= 0n, value <= 10n]; }: bigint { return value; }
bounded(5n);`,
  },
  {
    name: "opaque argument",
    source: `declare function opaque(): bigint;
function successor(value: bigint) with { requires: value >= 0n; }: bigint { return value + 1n; }
successor(opaque());`,
    rejects: /successor call precondition could not be proved\./,
  },
  {
    name: "caller path assumptions",
    source: `function successor(value: bigint) with { requires: value >= 0n; }: bigint { return value + 1n; }
function wrapper(value: bigint) with { requires: value >= 0n; }: bigint { return successor(value); }`,
  },
  {
    name: "branch facts for requires",
    source: `function positive(value: bigint) with { requires: value > 0n; }: bigint { return value; }
function guarded(value: bigint): bigint { if (value > 0n) positive(value); return value; }`,
  },
  {
    name: "opaque callee result",
    source: `declare function identity(value: bigint): bigint;
function opaque(x: bigint) with { ensures: result === x; }: bigint { return identity(x); }`,
    rejects: /opaque postcondition could not be proved\./,
  },
  {
    name: "number without model",
    source: `function addOne(x: number) with { ensures: result === x + 1; }: number { return x + 1; }`,
    rejects: /A number proof requires numberModel: 'mathematical-real' or 'safe-integer'\./,
  },
  {
    name: "number with real model",
    source: `function addOne(x: number) with { numberModel: "mathematical-real"; ensures: result === x + 1; }: number { return x + 1; }`,
  },
  {
    name: "refinement introduction",
    source: `type Positive = number with { numberModel: "mathematical-real"; predicate: value > 0; };
const age: Positive = 18;`,
  },
  {
    name: "refinement introduction fails",
    source: `type Positive = bigint with { predicate: value > 0n; };
const bad: Positive = -1n;`,
    rejects: /Positive refinement introduction could not be proved\./,
  },
  {
    name: "refinement via branch facts",
    source: `type Positive = bigint with { predicate: value > 0n; };
function guarded(value: bigint): Positive { if (value > 0n) return value; return 1n; }`,
  },
  {
    name: "stronger refinement through parameter",
    source: `type Positive = bigint with { predicate: value > 0n; };
type NonNegative = bigint with { predicate: value >= 0n; };
function widen(value: Positive): NonNegative { return value; }`,
  },
  {
    name: "record literal",
    source: `type Point = { x: bigint; y: bigint };
function origin() with { ensures: [result.x === 0n, result.y === 0n]; }: Point { return { x: 0n, y: 0n }; }`,
  },
  {
    name: "structured parameter and result",
    source: `type Point = { x: bigint; y: bigint };
function copy(point: Point) with { ensures: [result.x === point.x, result.y === point.y]; }: Point { return point; }`,
  },
  {
    name: "structured counterexample",
    source: `type Point = { x: bigint; y: bigint };
function bad(point: Point) with { ensures: result.x === 0n; }: Point { return point; }`,
    rejects: /bad postcondition could not be proved\./,
  },
  {
    name: "bigint truncating semantics",
    source: `function remainderOfNegative(a: bigint) with { requires: a < 0n; ensures: result <= 0n; }: bigint { return a % 3n; }
function halve(a: bigint) with { requires: a === -7n; ensures: result === -3n; }: bigint { return a / 2n; }`,
  },
  {
    name: "unchecked divisor",
    source: `function unchecked(a: bigint, b: bigint): bigint { assert: a === a; return a % b; }`,
    rejects: /division definedness could not be proved\./,
  },
  {
    name: "checked divisor",
    source: `function checked(a: bigint, b: bigint) with { requires: b > 0n; }: bigint { let total = 0n; if (a > 0n) total = a / b; return total; }`,
  },
  {
    name: "specifications are logic",
    source: `function same(a: bigint, b: bigint) with { requires: b !== 0n && a % b === 0n; ensures: result % b === 0n; }: bigint { return a; }`,
  },
  {
    name: "trusted assumptions",
    source: `function trusted(x: bigint): bigint { assume: x > 10n; assume: x < 1000n; assert: x > 5n; return x; }`,
  },
  {
    name: "safe-integer loop",
    source: `function sum(n: number) with { numberModel: "safe-integer"; requires: n >= 0 && n <= 1000; ensures: result >= 0; }: number {
  let i = 0; let total = 0;
  while (i < n) with { invariant: [i >= 0, i <= n, total >= 0, total <= i * 1000]; } { total += i; i += 1; }
  return total;
}`,
  },
  {
    name: "safe-integer overflow",
    source: `function double(x: number) with { numberModel: "safe-integer"; }: number { return x * 2; }`,
    rejects: /safe-integer range could not be proved\./,
  },
  {
    name: "safe-integer non-integer literal",
    source: `function half(x: number) with { numberModel: "safe-integer"; ensures: result >= 0; }: number { return 0.5; }`,
    rejects: /Numeric literal '0\.5' is not a safe integer\./,
  },
  {
    name: "safe-integer inexact division",
    source: `function ratio(x: number) with { numberModel: "safe-integer"; ensures: result >= 0; }: number { return x / 2; }`,
    rejects: /safe-integer exact division could not be proved\./,
  },
  {
    name: "unknown number model",
    source: `function b(x: number) with { numberModel: "ieee-float64"; ensures: result === x; }: number { return x; }`,
    rejects: /A number proof requires numberModel: 'mathematical-real' or 'safe-integer'\./,
  },
  {
    name: "callee ensures summary",
    source: `function double(x: bigint) with { ensures: result === x * 2n; }: bigint { return x + x; }
function quadruple(x: bigint) with { ensures: result === x * 4n; }: bigint { return double(double(x)); }`,
  },
  {
    name: "callee without ensures is unconstrained",
    source: `function opaque(x: bigint): bigint { return x; }
function caller(x: bigint) with { ensures: result === x; }: bigint { return opaque(x); }`,
    rejects: /caller postcondition could not be proved\./,
  },
  {
    name: "self recursion does not assume own ensures",
    source: `function grow(x: bigint) with { ensures: result > x; }: bigint { return grow(x); }`,
    rejects: /grow postcondition could not be proved\./,
  },
  {
    name: "logic function in executable code",
    source: `import * as smt from "ts-plus-plus/plugins/formal-verification/smt";
const isEven = smt.definePredicate([["value", smt.Int]], value => smt.eq(smt.js.rem(value, 2n), 0n));
function f(x: bigint) with { requires: x > 0n; }: bigint { if (isEven(x)) return x; return 0n; }`,
    rejects: /Logic function 'isEven' can only be used in a formal verification specification\./,
  },
  {
    name: "user-defined assert function call",
    source: `function assert(condition: unknown, message?: string): void {}
function check(x: bigint): bigint { assert(x > 0n); return x; }`,
  },
  {
    name: "ordinary boolean function as predicate",
    source: `function isEven(_value: bigint): boolean { return false; }
type Local = bigint with { predicate: isEven(value); };
const value: Local = 2n;`,
    rejects: /Unknown proof variable 'isEven'\./,
  },
  {
    name: "safe-integer fraction compared as integer",
    source: `function z(x: number) with { numberModel: "safe-integer"; ensures: result === 0; }: number { return 0.5; }`,
    rejects: /Numeric literal '0\.5' is not a safe integer\./,
  },
  {
    name: "logic function at top-level runtime code",
    source: `import * as smt from "ts-plus-plus/plugins/formal-verification/smt";
const isEven = smt.definePredicate([["value", smt.Int]], value => smt.eq(smt.js.rem(value, 2n), 0n));
console.log(isEven(2n));`,
    rejects: /Logic function 'isEven' can only be used in a formal verification specification\./,
  },
  {
    name: "logic function in assert and recursive definition",
    source: `import * as smt from "ts-plus-plus/plugins/formal-verification/smt";
const triangular = smt.defineRecursiveFunction([["value", smt.Int]], smt.Int, value => smt.ite(smt.le(value, 0n), 0n, smt.add(value, triangular(smt.sub(value, 1n)))));
assert: triangular(4n) === 10n;`,
  },
];

for (const testCase of cases) {
  test(`${testCase.rejects ? "rejects" : "verifies"} ${testCase.name}`, () => expectVerification(testCase));
}
