const test = require("node:test");
const { expectVerification } = require("./analyze.cjs");

// Each rejected case below used to verify silently even though its contract is false at runtime.
// The accepted cases guard against fixing those holes by rejecting ordinary, verifiable code.
const cases = [
  {
    name: "r++ ignored",
    source: `function q6(value: bigint) with { ensures: result === value; }: bigint { let r = value; r++; return r; }`,
    rejects: /q6 postcondition could not be proved\./,
  },
  {
    name: "break in loop",
    source: `function q2(limit: bigint) with { requires: limit >= 10n; ensures: result === limit; }: bigint {
    let current: bigint = 0n;
    while (current < limit) with { invariant: [current >= 0n, current <= limit]; } { if (current === 3n) break; current += 1n; }
    return current;
}`,
    rejects: /q2 postcondition could not be proved\./,
  },
  {
    name: "try catch",
    source: `function q3(value: bigint) with { ensures: result > 0n; }: bigint { try { throw 1; } catch { return 0n; } }`,
    rejects: /This return is outside the code the verifier can analyze, so it is not verified\./,
  },
  {
    name: "misspelled postcondition key",
    source: `function typo(value: bigint) with { ensure: result > value; }: bigint { return value; }`,
    rejects: /The 'with' property 'ensure' is not supported on a function\./,
  },
  {
    name: "duplicate postcondition key",
    source: `function twice(value: bigint) with { ensures: result >= value; ensures: result === value; }: bigint { return value; }`,
    rejects: /The 'with' property 'ensures' may only be specified once\./,
  },
  {
    name: "duplicate loop invariant key",
    source: `function count(limit: bigint) with { requires: limit >= 0n; ensures: result === limit; }: bigint {
    let current = 0n;
    while (current < limit) with { invariant: current >= 0n; invariant: current <= limit; } { current += 1n; }
    return current;
}`,
    rejects: /The 'with' property 'invariant' may only be specified once\./,
  },
  {
    name: "contract key on a loop",
    source: `function loop(limit: bigint) with { requires: limit >= 0n; }: bigint {
    let current = 0n;
    while (current < limit) with { invariant: current <= limit; ensures: true; } { current += 1n; }
    return current;
}`,
    rejects: /The 'with' property 'ensures' is not supported on a loop\./,
  },
  {
    name: "duplicate refinement predicate",
    source: `type Positive = bigint with { predicate: value > 0n; predicate: value > 1n; };`,
    rejects: /The 'with' property 'predicate' may only be specified once\./,
  },
  {
    name: "guarded call from ordinary number code",
    source: `function positive(value: bigint) with { requires: value > 0n; }: bigint { return value; }
function scale(factor: number): number { positive(-1n); return factor; }`,
    rejects: /The call to 'positive' is outside the code the verifier can analyze/,
  },
  {
    name: "safe-integer division",
    source: `function half(value: number) with { numberModel: "safe-integer"; requires: value === 5; ensures: result === 2; }: number { return value / 2; }`,
    rejects: /safe-integer exact division could not be proved\./,
  },
  {
    name: "for loop",
    source: `function forLoop(limit: bigint) with { ensures: result === 0n; }: bigint { let total = 0n; for (let i = 0n; i < 3n; i = i + 1n) { total = total + 1n; } return total; }`,
    rejects: /forLoop postcondition cannot be verified because '/,
  },
  {
    name: "do while",
    source: `function doLoop(limit: bigint) with { ensures: result === 0n; }: bigint { let total = 0n; do { total = total + 1n; } while (total < 3n); return total; }`,
    rejects: /doLoop postcondition cannot be verified because '/,
  },
  {
    name: "top-level reassignment before assert",
    source: `let x = 1n;
x = 2n;
assert: x === 1n;`,
    rejects: /local assertion could not be proved\./,
  },
  {
    name: "top-level assert inside block",
    source: `if (true) { assert: 1n === 2n; }`,
    rejects: /This assert is outside the code the verifier can analyze, so it is not verified\./,
  },
  {
    name: "while without invariant",
    source: `function w(n: bigint) with { ensures: result === 0n; }: bigint { let r = 0n; while (r < 3n) { r = r + 1n; } return r; }`,
    rejects: /w postcondition could not be proved\./,
  },
  {
    name: "switch fallthrough",
    source: `function s(b: bigint) with { ensures: result === 1n; }: bigint { let r = 0n; switch (b) { case 1n: r = 1n; case 2n: r = 2n; break; default: r = 1n; } return r; }`,
    rejects: /s postcondition could not be proved\./,
  },
  {
    name: "switch no default",
    source: `function s2(b: bigint) with { ensures: result === 1n; }: bigint { let r = 5n; switch (b) { case 1n: r = 1n; break; } return r; }`,
    rejects: /s2 postcondition could not be proved\./,
  },
  {
    name: "block shadowing",
    source: `function sh(value: bigint) with { ensures: result === value; }: bigint { if (value > 0n) { const value = 0n; } return value; }`,
    rejects: /sh postcondition cannot be verified because '/,
  },
  {
    name: "loop body sees only initial values",
    source: `function lb(n: bigint) with { requires: n >= 0n; }: bigint { let i = 0n; while (i < n) with { invariant: [i >= 0n]; } { assert: i === 0n; i += 1n; } return i; }`,
    rejects: /local assertion could not be proved\./,
  },
  {
    name: "call does not check parameter refinement",
    source: `type Positive = bigint with { predicate: value > 0n; };
function widen(value: Positive): bigint { return value; }
function caller(): bigint { return widen(-1n); }`,
    rejects: /Positive argument refinement could not be proved\./,
  },
  {
    name: "global mutated by function",
    source: `let g = 1n;
function bump(): void { g = 2n; }
bump();
assert: g === 1n;`,
    rejects: /local assertion could not be proved\./,
  },
  {
    name: "call in arrow function",
    source: `function successor(value: bigint) with { requires: value >= 0n; }: bigint { return value + 1n; }
const f = () => successor(-1n);`,
    rejects: /The call to 'successor' is outside the code the verifier can analyze, so it is not verified\./,
  },
  {
    name: "unknown call taints record",
    source: `type Point = { x: bigint };
function px(p: Point) with { requires: p.x === 1n; ensures: result === 1n; }: bigint { mutate(p); return p.x; }`,
    rejects: /px postcondition cannot be verified because '/,
  },
  {
    name: "real division by zero",
    source: `function rd(value: number) with { numberModel: "mathematical-real"; ensures: result === 0; }: number { return value / 0; }`,
    rejects: /division definedness could not be proved\./,
  },
  {
    name: "bare return then assert",
    source: `function br(b: bigint): void { if (b > 0n) return; assert: b <= 0n; }`,
  },
  {
    name: "plain function with console.log and for loop",
    source: `function greet(name: string): void { for (let i = 0; i < 3; i++) { console.log(name); } }`,
  },
  {
    name: "counted loop with continue and break",
    source: `function count(limit: bigint) with { requires: limit >= 0n; ensures: result === limit; }: bigint {
    let current = 0n;
    while (true) with { invariant: [current >= 0n, current <= limit]; } {
        if (current === limit) break;
        current++;
        continue;
    }
    return current;
}`,
  },
  {
    name: "grouped switch cases",
    source: `function g2(b: bigint) with { ensures: result >= 0n; }: bigint { switch (b) { case 1n: case 2n: return b; default: return 0n; } }`,
  },
  {
    name: "exact safe-integer division",
    source: `function ev(value: number) with { numberModel: "safe-integer"; requires: value === 6; ensures: result === 3; }: number { return value / 2; }`,
  },
  {
    name: "sibling blocks reuse a name",
    source: `function sib(a: bigint) with { ensures: result === a; }: bigint { if (a > 0n) { const t = a; } if (a < 0n) { const t = a; } return a; }`,
  },
  {
    name: "throw on invalid input",
    source: `function pos(a: bigint) with { ensures: result > 0n; }: bigint { if (a <= 0n) throw new Error("no"); return a; }`,
  },
  {
    name: "field assignment",
    source: `type Point = { x: bigint };
function setx(p: Point) with { ensures: result === 5n; }: bigint { p.x = 5n; return p.x; }`,
  },
  {
    name: "ordinary number functions and top-level calls beside verified code",
    source: `function scale(shape: { size: number }, factor: number): number { return shape.size * factor; }
const scaled = scale({ size: 2 }, 3);
function absolute(value: bigint) with { ensures: result >= 0n; }: bigint { if (value < 0n) return -value; return value; }`,
  },
  {
    name: "macro with clause left to the compiler",
    source: `macro function first([target], context) with { timeout: { type: "fixed", value: 1, unit: "s" }; } { return target; }`,
  },
  {
    name: "call uses callee return refinement",
    source: `type Positive = bigint with { predicate: value > 0n; };
function one(): Positive { return 1n; }
function useOne() with { ensures: result > 0n; }: bigint { return one(); }`,
  },
];

for (const testCase of cases) {
  test(`${testCase.rejects ? "rejects" : "verifies"} ${testCase.name}`, () => expectVerification(testCase));
}
