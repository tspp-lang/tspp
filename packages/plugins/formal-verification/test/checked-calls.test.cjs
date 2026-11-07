const assert = require("node:assert/strict");
const test = require("node:test");
// Registers the plugins with the host compiler.
require("./analyze.cjs");
const { createProgram, diagnosticMessages, ts } = require("../../test-support/compile.cjs");

// Through the compiler, the analyzer receives the checker's resolution of every call, so receivers of any form, and
// classes and functions of other files, are checked against their contracts.

const player = `export class 玩家 with {
    invariant: 生命值 >= 0;
    numberModel: "mathematical-real";
} {
    private 生命值: number;
    public constructor(初始生命值: number) with { requires: 初始生命值 >= 0; } { this.生命值 = 初始生命值; }
    public 治疗(恢复值: number) with { requires: 恢复值 > 0; }: void { this.生命值 += 恢复值; }
    public 获得生命值() with { ensures: result >= 0; }: number { return this.生命值; }
}

export function 偶数一半(值: bigint) with { requires: 值 % 2n === 0n; ensures: result * 2n === 值; }: bigint {
    return 值 / 2n;
}
`;

/** Compiles the files with the plugins active and returns the compiler's and the analyzer's messages. */
async function analyze(main, extra = {}) {
  const { program } = createProgram({ "/player.tspp": player, ...extra, "/main.tspp": main });
  const compiler = diagnosticMessages(program);
  const analysis = (await ts.runTSPPProgramAnalyzers(program)).map(diagnostic => `${diagnostic.fileName}: ${diagnostic.message}`);
  return { compiler, analysis };
}

async function expectAnalysis(main, rejects, extra) {
  const { compiler, analysis } = await analyze(main, extra);
  assert.deepEqual(compiler, [], "the test program must type-check");
  if (!rejects) return assert.deepEqual(analysis, []);
  assert.ok(analysis.some(message => rejects.test(message)), `expected ${rejects}, received:\n${analysis.join("\n") || "(no diagnostics)"}`);
}

const imports = `import { 玩家, 偶数一半 } from "./player";\n`;

const cases = [
  {
    name: "calls into another file that satisfy its contracts",
    main: `${imports}const p = new 玩家(10);\np.治疗(5);\nconst half = 偶数一半(8n);`,
  },
  {
    name: "a method precondition from another file",
    main: `${imports}const p = new 玩家(10);\np.治疗(-5);`,
    rejects: /\/main\.tspp: 玩家\.治疗 call precondition could not be proved/,
  },
  {
    name: "a constructor precondition from another file",
    main: `${imports}const p = new 玩家(-1);`,
    rejects: /\/main\.tspp: 玩家\.constructor call precondition could not be proved/,
  },
  {
    name: "a function precondition from another file",
    main: `${imports}const half = 偶数一半(3n);`,
    rejects: /\/main\.tspp: 偶数一半 call precondition could not be proved/,
  },
  {
    name: "a receiver whose class is inferred",
    main: `${imports}function 创建(): 玩家 { return new 玩家(1); }\n创建().治疗(-5);`,
    rejects: /玩家\.治疗 call precondition could not be proved/,
  },
  {
    name: "a receiver read from another object",
    main: `${imports}declare const 队伍: { readonly 队长: 玩家 };\n队伍.队长.治疗(-5);`,
    rejects: /玩家\.治疗 call precondition could not be proved/,
  },
  {
    name: "a postcondition from another file",
    main: `${imports}function 查看(p: 玩家) with { numberModel: "mathematical-real"; ensures: result >= 0; }: number {
    return p.获得生命值();
}`,
  },
  {
    name: "a receiver typed by an interface",
    main: `${imports}interface 可治疗 { 治疗(恢复值: number): void; }
declare const 目标: 可治疗;
目标.治疗(-5);`,
    rejects: /The class of the receiver of '治疗' cannot be determined/,
  },
  {
    name: "a receiver that may be one of two classes",
    main: `${imports}class 草药 { 治疗(恢复值: number): void {} }
declare const 目标: 玩家 | 草药;
目标.治疗(-5);`,
    rejects: /The class of the receiver of '治疗' cannot be determined/,
  },
];

const override = /Overriding '玩家\.治疗', which has a contract, is not supported yet/;
cases.push(
  {
    name: "an override in another file than its base",
    main: `${imports}export class 法师 extends 玩家 { 治疗(恢复值: number): void {} }`,
    rejects: override,
  },
  {
    name: "an override through a class in a third file",
    extra: { "/warrior.tspp": `import { 玩家 } from "./player";\nexport class 战士 extends 玩家 {}` },
    main: `import { 战士 } from "./warrior";\nexport class 狂战士 extends 战士 { 治疗(恢复值: number): void {} }`,
    rejects: override,
  },
  {
    name: "an override in a class expression nested in a function",
    main: `${imports}export function 召唤() { return class extends 玩家 { 治疗(恢复值: number): void {} }; }`,
    rejects: override,
  },
  {
    name: "a derived class that overrides nothing with a contract",
    main: `${imports}export class 法师 extends 玩家 { 施法(): void {} }`,
  },
  {
    name: "a base the checker cannot follow",
    main: `${imports}declare function 混入<T>(base: T): T;
export class 法师 extends 混入(玩家) { 治疗(恢复值: number): void {} }`,
    rejects: /'治疗' may override a method with a contract/,
  },
);

for (const item of cases) test(item.name, () => expectAnalysis(item.main, item.rejects, item.extra));
