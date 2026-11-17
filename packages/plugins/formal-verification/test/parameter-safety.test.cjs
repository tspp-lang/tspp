const { test } = require("node:test");
const { expectVerification } = require("./analyze.cjs");

const cases = [
  {
    name: "immediate function field reads do not escape a record parameter",
    source: `function read(input: { value: bigint }) with { ensures: result === input.value; }: bigint {
      return (() => input.value)();
    }`,
  },
  {
    name: "a match reads scalar positional fields inside its immediate dispatch",
    source: `type Big = bigint; data Item = Value(value: Big) | Empty;
    function read(input: Item) with { ensures: result >= 0n; }: bigint {
      return match input { Value(value) => value >= 0n ? value : 0n, Empty => 0n };
    }`,
  },
  {
    name: "a returned closure still captures its record parameter",
    source: `function read(input: { value: bigint }) with { ensures: result >= 0n; }: bigint {
      const deferred = () => input.value;
      return 0n;
    }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "a closure inside immediate dispatch still escapes its record parameter",
    source: `function read(input: { value: bigint }) with { ensures: result >= 0n; }: bigint {
      const deferred = (() => () => input.value)();
      return 0n;
    }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "an immediate async function still captures its record parameter",
    source: `function read(input: { value: bigint }) with { ensures: result >= 0n; }: bigint {
      const deferred = (async () => { await 0; return input.value; })();
      return 0n;
    }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "an immediate generator still captures its record parameter",
    source: `function read(input: { value: bigint }) with { ensures: result >= 0n; }: bigint {
      const deferred = (function* () { yield input.value; })();
      return 0n;
    }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "returning a record through an immediate function still creates an alias",
    source: `function read(input: { value: bigint }) with { ensures: result === input.value; }: bigint {
      const alias = (function () { return input; })();
      alias.value = 0n;
      return 0n;
    }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "a match cannot hide an escaping recursive data payload",
    source: `data Item = Value(value: { value: bigint }) | Empty;
    function read(input: Item) with { ensures: result >= 0n; }: bigint {
      return match input { Value(value) => 0n, Empty => 0n };
    }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
];

for (const entry of cases) test(entry.name, () => expectVerification(entry));
