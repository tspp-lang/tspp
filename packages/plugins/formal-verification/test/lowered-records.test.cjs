const test = require("node:test");
const { expectVerification } = require("./analyze.cjs");

const cases = [
  {
    name: "a lowered dispatch reads scalar fields without capturing the record",
    source: `data Input = Value(value: bigint) | Empty;
      function read(input: Input) with { requires: input.value >= 1n; ensures: result >= 1n; }: bigint {
        return match input { Value(value) => value, Empty => 2n };
      }`,
  },
  {
    name: "scalar payloads follow chains of type aliases",
    source: `type Integer = bigint; type Amount = Integer;
      data Input = Value(value: Amount);
      function nonnegative(input: Input) with { ensures: result >= 0n; }: bigint {
        return match input { Value(value) => value >= 0n ? value : 0n };
      }`,
  },
  {
    name: "an exhaustive nullary match needs no value at its generated end",
    source: `data Choice = First | Second;
      function read(input: Choice) with { ensures: result >= 5n; }: bigint {
        return match input { First => 6n, Second => 7n };
      }`,
  },
  {
    name: "a false match postcondition still fails",
    source: `data Input = Value(value: bigint) | Empty;
      function read(input: Input) with { requires: input.value >= 1n; ensures: result >= 5n; }: bigint {
        return match input { Value(value) => value, Empty => 2n };
      }`,
    rejects: /read postcondition could not be proved/,
  },
  {
    name: "an authored never assertion cannot stand in for a generated match end",
    source: `function read(value: bigint) with { ensures: result >= 5n; }: bigint {
      return value > 3n ? 10n : (0n as never);
    }`,
    rejects: /Unsupported proof expression/,
  },
  {
    name: "a closure inside a lowered dispatch still captures its record",
    source: `data Input = Value(value: bigint) | Empty;
      declare function save(callback: () => bigint): bigint;
      function read(input: Input) with { ensures: result >= 0n; }: bigint {
        return match input { Value(value) => save(() => input.value), Empty => 0n };
      }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "a nested record payload stays an alias even through a type alias",
    source: `type Nested = { value: bigint }; type Payload = Nested;
      data Input = Value(child: Payload);
      function read(input: Input) with { ensures: result === 1n; }: bigint {
        const child = match input { Value(child) => child };
        return 1n;
      }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "a payload index that can hold an object cannot become a scalar alias",
    source: `data Input = NumberValue(value: bigint) | RecordValue(child: { value: bigint });
      function read(input: Input) with { ensures: result === 1n; }: bigint {
        const ignored = match input { NumberValue(value) => value, RecordValue(child) => child };
        return 1n;
      }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "the payload storage array itself remains an escaping alias",
    source: `data Input = Value(value: bigint);
      function read(input: Input) with { ensures: result === 1n; }: bigint {
        const alias = input._values; return 1n;
      }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "a nested ordinary record field cannot hide an alias and callback",
    source: `function read(input: { value: bigint; nested: { change(): void } })
        with { requires: input.value === 0n; ensures: result === 0n; }: bigint {
      const alias = input.nested; alias.change(); return input.value;
    }`,
    rejects: /record parameter is aliased, escaped, or captured/,
  },
  {
    name: "record writes in a lowered dispatch cannot supply an entry-state call summary",
    source: `data Input = Value(value: bigint);
      function change(input: Input) with { ensures: result === input.value; }: bigint {
        return match input { Value(value) => input.value = 1n };
      }
      function read() with { ensures: result === 0n; }: bigint {
        return change(Value(0n));
      }`,
    rejects: /record parameter is written/,
  },
];

for (const testCase of cases) {
  test(`${testCase.rejects ? "rejects" : "verifies"} ${testCase.name}`, () => expectVerification(testCase));
}
