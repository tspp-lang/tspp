// Prints what one program compiles to, with the plugin packages given as a comma-separated list loaded in that order.
const { ts, usePlugins, createProgram, diagnosticMessages, emitJavaScript, createLanguageService } = require("../../test-support/compile.cjs");

for (const directory of process.argv[2].split(",")) {
  const exports = require(require("node:path").join(directory, "dist/index.js"));
  usePlugins(exports.default ?? Object.values(exports).find(value => value?.manifest));
}

const source = `
data S = A(x: number) | B;
newtype Id = number;
export const i = Id(1);
const s: S = A(1);
export const a = let v = 1 in v;
export const b = match s { A(x) => x, B => 2 };
export const c = [1].map((_ + 1));
export const d = do { def q = { a: 1 }; q.a };
export type C = let X = string in match X { string: 1, _: 2 };
export type Unused<T> = let Y = number in string;
type Lst: Type => Type = <E> =>> E[];
export const l: Lst<number> = [1];
export const bad: Lst<number> = "x";
export type Two: Nat = NatAdd<Succ<Zero>, Succ<Zero>>;
const de = reify number;
export const t = typecase de { number => "n", _ => "o" };
export interface P { static p(): number; inner: S; }
export function f(v: bigint) with { requires: v >= 0n; ensures: result >= 0n; }: bigint { return let k = v in k; }
macro function named([target], context) {
  return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
    context.factory.createVariableDeclaration(target.name + "Name", undefined, undefined, context.factory.createStringLiteral(target.name))]));
}
interface Mi { a: number }
macro named(Mi);
export const n = MiName;
`;

const { program, outputs } = createProgram({ "/main.tspp": source }, {
  noLib: false, lib: ["lib.es2022.d.ts"], noImplicitAny: false, declaration: true, noUnusedLocals: true,
});
const service = createLanguageService("/main.tspp", source);
const hovers = ["let v", "match s", "let X", "match X", "Type =>", "reify", "typecase", "do {", "Two", "static", "macro named", "requires"].map(text => {
  const info = service.getQuickInfoAtPosition("/main.tspp", source.indexOf(text));
  return info ? `${ts.displayPartsToString(info.displayParts)} | ${ts.displayPartsToString(info.documentation ?? [])}` : "";
});
ts.runTSPPProgramAnalyzers(program).then(analysis => {
  emitJavaScript(program, outputs);
  console.log(JSON.stringify([
    diagnosticMessages(program),
    analysis.map(diagnostic => diagnostic.message),
    ts.getTSPPAnalysisArtifacts(program).map(artifact => `${artifact.name}: ${artifact.status}`),
    [...outputs].sort(),
    hovers,
  ]));
  process.exit(0);
});
