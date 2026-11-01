// Compiles, verifies, and runs one program that uses every feature plugin at once. Each plugin's own tests enable it
// alone; this catches plugins that claim the same keywords or tokens, and lowerings that break each other once nested.
const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const { ts, createProgram, diagnosticMessages, emitJavaScript } = require("../../test-support/compile.cjs");
const { useAllPlugins } = require("./plugins.cjs");

useAllPlugins();

const options = { noLib: false, lib: ["lib.es2022.d.ts"], noImplicitAny: false };

const source = `
// nominal-types
newtype UserId = number;
export data Shape = Circle(radius: number) | Rect(width: number, height: number);

// modern-syntax inside a nominal match, with an operator section in an arm
export function area(shape: Shape): number {
    return match shape {
        Circle(radius) => let squared = radius * radius in 3 * squared,
        Rect(width, height) => [width].map((_ * height))[0],
    };
}
export const total = do {
    const circle = area(Circle(1));
    const rect = area(Rect(2, 3));
    circle + rect
};

// type-computation and higher-kinded-types
type Box<T> = { value: T };
type Apply<F: Type => Type, X> = F<X>;
type Selected<T> = match T { string: "text", number: "number", _: "other" };
type Pair = let P = <A> =>> [A, A] in P<number>;
export const kind: Selected<UserId> = "number";
export const boxed: Apply<Box, string> = { value: "boxed" };
export const pair: Pair = [4, 5];

// dependent-types
export type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;
export type Chosen: Type0 = match mltt number { number: string, _: boolean };
export const chosen: Chosen = "dependent";

// static-interface-members
interface Parser {
    static parse(text: string): number;
}
class IntParser implements Parser {
    static parse(text: string): number { return Number(text); }
}
export const parsed = IntParser.parse("41") + 1;

// formal-verification
export function clamp(value: bigint) with {
    requires: value >= 0n;
    ensures: result >= 0n && result <= 10n;
}: bigint {
    if (value > 10n) return 10n;
    return value;
}

// macros
macro function named([target], context) {
    return context.factory.createVariableStatement(
        undefined,
        context.factory.createVariableDeclarationList([
            context.factory.createVariableDeclaration(
                target.name + "Name",
                undefined,
                context.factory.createLiteralTypeNode(context.factory.createStringLiteral(target.name)),
                context.factory.createStringLiteral(target.name),
            ),
        ]),
    );
}
interface Account { id: UserId }
macro named(Account);
export const accountName: "Account" = AccountName;
`;

test("every plugin together type-checks, verifies, and runs", async () => {
  const { program, outputs } = createProgram({ "/main.tspp": source }, options);
  assert.deepEqual(diagnosticMessages(program), []);

  const analysis = await ts.runTSPPProgramAnalyzers(program);
  assert.deepEqual(analysis.map(diagnostic => diagnostic.message), []);
  const proofs = ts.getTSPPAnalysisArtifacts(program).map(artifact => `${artifact.name}: ${artifact.status}`);
  assert.ok(proofs.length > 0 && proofs.every(proof => proof.endsWith(": proved")), proofs.join("\n"));

  const exports = {};
  // Run in this realm so that emitted objects compare structurally with the expected values.
  vm.runInThisContext(`(function (exports, module) {\n${emitJavaScript(program, outputs)}\n})`)(exports, { exports });
  assert.equal(exports.area(exports.Circle(2)), 12);
  assert.equal(exports.total, 9);
  assert.equal(exports.kind, "number");
  assert.deepEqual(exports.boxed, { value: "boxed" });
  assert.deepEqual(exports.pair, [4, 5]);
  assert.equal(exports.chosen, "dependent");
  assert.equal(exports.parsed, 42);
  assert.equal(exports.clamp(20n), 10n);
  assert.equal(exports.accountName, "Account");
});

test("every plugin together still reports each plugin's errors", async () => {
  const broken = source
    .replace("Rect(width, height) => [width].map((_ * height))[0],", "")
    .replace(`export const kind: Selected<UserId> = "number";`, `export const kind: Selected<UserId> = "text";`)
    .replace("return Number(text);", "return text;")
    .replace("ensures: result >= 0n && result <= 10n;", "ensures: result >= 1n && result <= 10n;");
  const { program } = createProgram({ "/main.tspp": broken }, options);
  const messages = diagnosticMessages(program).join("\n");
  assert.match(messages, /Non-exhaustive match\. Missing patterns: Rect/);
  assert.match(messages, /Type '"text"' is not assignable to type '"number"'/);
  assert.match(messages, /Type 'string' is not assignable to type 'number'/);
  const analysis = (await ts.runTSPPProgramAnalyzers(program)).map(diagnostic => diagnostic.message).join("\n");
  assert.match(analysis, /clamp postcondition could not be proved/);
});
