const assert = require("node:assert/strict");
const test = require("node:test");
const { analyzeSource, expectVerification } = require("./analyze.cjs");

const numberModels = ["safe-integer", "mathematical-real"];

test("distinguishes number and bigint literals in executable comparisons and contracts", async () => {
  for (const model of numberModels) {
    await expectVerification({ source: `
function different() with {
  numberModel: "${model}"; ensures: [result, 0 !== 0n];
}: boolean { const zero: any = 0; return zero !== 0n; }
function equal() with {
  numberModel: "${model}"; ensures: !result;
}: boolean { const zero: any = 0; return zero === 0n; }
` });
  }
});

test("rejects false number-bigint equality in executable comparisons and contracts", async () => {
  for (const model of numberModels) {
    for (const [ensure, expression] of [["result", "zero === 0n"], ["0 === 0n", "true"]]) {
      await expectVerification({
        source: `function bad() with {
          numberModel: "${model}"; ensures: ${ensure};
        }: boolean { const zero: any = 0; return ${expression}; }`,
        rejects: /bad postcondition could not be proved/,
      });
    }
  }
});

test("rejects the plain and counted-loop branch proofs that equated number zero with bigint zero", async () => {
  for (const body of [
    "const i = 0n; if (i === zero) return 0; return 1;",
    "for (let i = 0n; i < 1n; i++) { if (i === zero) return 0; return 1; } return 0;",
  ]) {
    await expectVerification({
      source: `function bad() with {
        numberModel: "safe-integer"; ensures: result === 0;
      }: number { const zero: any = 0; ${body} }`,
      rejects: /bad postcondition could not be proved/,
    });
  }
});

test("preserves numeric identity for parameters and call results without bounding bigint parameters", async () => {
  for (const model of numberModels) {
    await expectVerification({ source: `
function numberValue(value: number) with {
  numberModel: "${model}"; ensures: [result, value !== 0n];
}: boolean { const alias: any = value; return alias !== 0n; }
function bigintValue(value: bigint) with {
  numberModel: "${model}"; ensures: [result, value !== 0];
}: boolean { const alias: any = value; return alias !== 0; }
function numberZero() with {
  numberModel: "${model}"; ensures: result === 0;
}: number { return 0; }
function bigintZero() with { ensures: result === 0n; }: bigint { return 0n; }
function called() with {
  numberModel: "${model}"; ensures: result;
}: boolean {
  const number: any = numberZero();
  const bigint: any = bigintZero();
  return number !== 0n && bigint !== 0;
}
` });
  }
  await expectVerification({
    source: `function large(value: bigint) with {
      numberModel: "safe-integer";
      requires: value > 9007199254740991n;
      ensures: false;
    }: bigint { return value; }`,
    rejects: /large postcondition could not be proved/,
  });
});

test("preserves number identity when a while loop makes its assigned variable symbolic", async () => {
  for (const model of numberModels) {
    const source = `function afterLoop() with {
      numberModel: "${model}"; ensures: result;
    }: boolean {
      let current = 0;
      while (current === 0) with { invariant: current === 0 || current === 1; } {
        current = 1;
      }
      const alias: any = current;
      return alias !== 1n;
    }`;
    await expectVerification({ source });
    await expectVerification({
      source: source.replace("alias !== 1n", "alias === 1n"),
      rejects: /afterLoop postcondition could not be proved/,
    });
  }
});

test("rejects a loop write that would give a binding a different numeric type", async () => {
  await expectVerification({
    source: `function mixed(flag: boolean) with {
      numberModel: "safe-integer"; ensures: result;
    }: boolean {
      let value: any = 0;
      while (flag) { value = 0n; flag = false; }
      return value !== 0n;
    }`,
    rejects: /Cannot change the proof sort of 'value'/,
  });
});

test("does not keep the numeric type of a global that an unmodeled write can change", async () => {
  for (const write of [
    "function change(): void { value = 0n; } change();",
    "(() => { value = 0n; })();",
    "function change(): void { [value] = [0n]; } change();",
  ]) {
    await expectVerification({
      source: `let value: any = 0; ${write} assert: value !== 0n;`,
      rejects: /Unknown proof variable 'value'/,
    });
  }
});

test("does not use a top-level function's model for a shadowing local call", async () => {
  await expectVerification({
    source: `function change(): void {}
function shadowed() with { numberModel: "safe-integer"; ensures: result; }: boolean {
  let value: any = 0;
  function change(): void { value = 0n; }
  change();
  return value !== 0n;
}`,
    rejects: /postcondition cannot be verified because/,
  });
});

test("distinguishes numeric types in a logic definition's strict comparison", async () => {
  await expectVerification({ source: `
import * as smt from "ts-plus-plus/plugins/formal-verification/smt";
const different = smt.definePredicate([["value", smt.Int]], value => value !== 0);
const nonnegative = smt.definePredicate([["value", smt.Int]], value => value >= 0);
function testIdentity(value: bigint) with {
  requires: value >= 0n;
  ensures: [different(value), nonnegative(value)];
}: bigint { return value; }
` });
});

test("checks numeric types across call boundaries", async () => {
  const source = `
function bigintOnly(value: bigint) with { ensures: result === value; }: bigint { return value; }
function implicitZero() { return 0; }
function caller() with { numberModel: "safe-integer"; ensures: result; }: boolean {
  const zero: any = 0;
  return zero === 0;
}
`;
  await expectVerification({
    source: source.replace("return zero === 0;", "return bigintOnly(zero) !== 0;"),
    rejects: /Argument 1 of 'bigintOnly' must have proof sort/,
  });
  await expectVerification({
    source: source.replace("return zero === 0;", "return implicitZero() !== 0;"),
    rejects: /A call used as a proof value needs a modeled return type/,
  });
  await expectVerification({
    source: `function bigintOnly() with {
      numberModel: "safe-integer"; ensures: true;
    }: bigint { const zero: any = 0; return zero; }`,
    rejects: /Return value must have proof sort/,
  });
});

test("does not guess the numeric type of a union field", async () => {
  await expectVerification({
    source: `type Input = { value: bigint } | { value: number } | { value: bigint; label: string };
    function inspect(input: Input) with { numberModel: "safe-integer"; ensures: result; }: boolean {
      const value: any = input.value;
      return value !== 0;
    }`,
    rejects: /Unknown proof (field|variable)/,
  });
});

test("treats integers and reals as the same JavaScript number type", async () => {
  await expectVerification({ source: `
function integerZero() with { numberModel: "safe-integer"; ensures: result === 0; }: number { return 0; }
function realZero() with { numberModel: "mathematical-real"; ensures: result === 0; }: number { return 0; }
function compare() with { numberModel: "safe-integer"; ensures: result; }: boolean {
  return integerZero() === realZero();
}
` });
});

test("rejects false promises about mixed numeric conditional and immediately-invoked results", async () => {
  for (const model of numberModels) {
    for (const expression of [
      "flag ? 0 : 0n",
      "(() => { if (flag) return 0; return 0n; })()",
    ]) {
      const messages = await analyzeSource(`function mixed(flag: boolean) with {
        numberModel: "${model}"; ensures: result;
      }: boolean {
        const value: any = ${expression};
        return value === 0n;
      }`);
      assert.notDeepEqual(messages, [], `${model}: ${expression} promises true for a number-valued branch`);
    }
  }
});

test("keeps same-type arithmetic and strict equality provable", async () => {
  for (const model of numberModels) {
    await expectVerification({ source: `
function numberStep(value: number) with {
  numberModel: "${model}";
  requires: value >= -10 && value <= 10;
  ensures: result === value + 1;
}: number {
  const next = value + 1;
  assert: next !== value;
  return next;
}
function bigintStep(value: bigint) with {
  numberModel: "${model}"; ensures: result === value + 1n;
}: bigint {
  const next = value + 1n;
  assert: next !== value;
  return next;
}
` });
  }
});
