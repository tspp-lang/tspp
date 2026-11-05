// Each plugin's syntax written inside each other plugin's, through the real command line. `cli-matrix.test.cjs` puts
// plugins side by side, which shows they leave each other alone; this shows they compose. A plugin lists where it holds
// code (`holds`) and the code it offers (`offers`), and every pairing follows from those lists, so a new plugin adds one
// entry here and no test per pair. A pairing must compile, run to its value, and report the error of its `bad` variant;
// a place that `declares` must also keep the syntax it holds in its `.d.tspp`. A place that `mayRefuse` is verified code:
// lowered code outside what proofs can model may be refused with the verifier's own diagnostic, never misread or accepted
// silently. Only what a plugin can write anywhere is offered: `data` and `newtype` declare at the top level of a module.
// A plugin that holds expressions lists where an operator section's hole reaches through it (`reaches`), or says that its
// places are functions an author wrote (`scopes`): whatever it lowers to, a hole must find its section.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { allPlugins } = require("./plugins.cjs");

const tsc = path.join(path.dirname(require.resolve("ts-plus-plus/package.json")), "built", "local", "tsc.js");

const macro = `macro function named([target], context) {
  return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
    context.factory.createVariableDeclaration(target.name + "Name", undefined, undefined, context.factory.createStringLiteral(target.name))]));
}`;
const contract = "with { ensures: result >= v; }";

// Expressions offered here evaluate to 3, and types offered here accept 3 and refuse a string.
const features = {
  "advanced-classes": {
    scopes: true,
    offers: {
      expression: [{
        prelude: "data class DataVal(a: number);\nconst dBox = new DataVal(1);",
        code: "(with(dBox, { a: 3 }).a)",
      }],
    },
    holds: {
      expression: [{
        wrap: code => `data class Holder(a: number);\nconst hBox = new Holder(0);\nexport const value = with(hBox, { a: ${code} }).a;`,
      }],
    },
  },
  "formal-verification": {
    scopes: true,
    offers: {
      statement: [{ code: "function inner(v: bigint) with { ensures: result >= v; }: bigint { return v; }" }],
    },
    holds: {
      expression: [{ wrap: code => `function proved(v: bigint) ${contract}: bigint { const held = ${code}; return v; }\nexport const value = proved(1n) === 1n ? 3 : 0;`, mayRefuse: /error TS19003:/ }],
      type: [{
        wrap: type => `export function proved(v: bigint, n: ${type}) ${contract}: bigint { return v; }\nexport const value = proved(1n, 3) === 1n ? 3 : 0;`,
        bad: type => `export function proved(v: bigint, n: ${type}) ${contract}: bigint { return v; }\nexport const wrong = proved(1n, "x");`,
        declares: true,
      }],
      statement: [{ wrap: code => `function proved(v: bigint) ${contract}: bigint { ${code} return v; }\nexport const value = proved(1n) === 1n ? 3 : 0;` }],
    },
  },
  macros: {
    offers: {},
    holds: {
      type: [{
        wrap: type => `${macro}\nexport type Target = { a: ${type} };\nmacro named(Target);\nexport const value = TargetName === "Target" ? 3 : 0;`,
        bad: type => `${macro}\nexport type Target = { a: ${type} };\nmacro named(Target);\nexport const wrong: Target = { a: "x" };`,
        declares: true,
      }],
    },
  },
  "modern-syntax": {
    reaches: [
      { wrap: hole => `do { const a = ${hole}; a }` },
      { wrap: hole => `let b = ${hole} in b` },
      { prelude: "function apply<T>(x: number, k: (v: number) => T): T { return k(x); }", wrap: hole => `do { use v <- apply(1); v + ${hole} - 1 }` },
    ],
    offers: {
      expression: [{ code: "do { const a = 2; a + 1 }" }, { code: "let b = 2 in b + 1" }],
      statement: [{ code: "def held = { a: 1 };" }],
    },
    holds: {
      expression: [
        { wrap: code => `export const value = do { const inner = ${code}; inner };` },
        { wrap: code => `export const value = let inner = ${code} in inner;` },
        { wrap: code => `function apply<T>(x: number, k: (v: number) => T): T { return k(x); }\nexport const value = do { use v <- apply(${code}); v };` },
      ],
      type: [{
        wrap: type => `export const value = do { const a: ${type} = 3; a };`,
        bad: type => `export const wrong = do { const a: ${type} = "x"; a };`,
      }],
      statement: [{ wrap: code => `export const value = do { ${code} 3 };` }],
    },
  },
  "nominal-types": {
    reaches: [{ prelude: "data Con = ConA | ConB;\nconst con: Con = ConA;", wrap: hole => `match con { ConA => ${hole}, ConB => 0 }` }],
    offers: {
      expression: [{ prelude: "data Offered = OfferedA(x: number) | OfferedB;\nconst offered: Offered = OfferedA(3);", code: "match offered { OfferedA(x) => x, OfferedB => 0 }" }],
    },
    holds: {
      expression: [{ wrap: code => `data Con = ConA | ConB;\nconst con: Con = ConA;\nexport const value = match con { ConA => ${code}, ConB => 0 };` }],
      type: [
        {
          wrap: type => `export data Con = Con(f: ${type});\nexport const value = match Con(3) { Con(f) => f };`,
          bad: type => `export data Con = Con(f: ${type});\nexport const wrong = Con("x");`,
          declares: true,
        },
        {
          wrap: type => `export newtype Id = ${type};\nexport const value: number = Id(3);`,
          bad: type => `export newtype Id = ${type};\nexport const wrong = Id("x");`,
          declares: true,
        },
      ],
    },
  },
  "operator-sections": {
    offers: {
      expression: [{ code: "[2].map((_ + 1))[0]" }],
    },
    holds: {
      expression: [{ wrap: code => `export const value = [0].map((_ + ${code}))[0];` }],
      type: [{
        wrap: type => `export const value = [3].map((_ as ${type}))[0];`,
        bad: type => `export const wrong: string = [3].map((_ as ${type}))[0];`,
      }],
    },
  },
  "algebraic-effects": {
    reaches: [
      { prelude: "effect Reach { touch(): void; }", wrap: hole => `handle Reach { touch() {} } in { ${hole} }` },
    ],
    offers: {
      expression: [{
        prelude: "effect Give { three(): number; }",
        code: "handle Give { three: () => 3 } in { perform Give.three() }",
      }],
      statement: [{ code: "effect Local { touch(): void; }" }],
    },
    holds: {
      expression: [
        { wrap: code => `effect Hold { hold(): any; }\nhandle Hold { hold: () => 0 } in { perform Hold.hold(); };\nexport const value = handle Hold { hold: () => ${code} } in { perform Hold.hold() };` },
        { wrap: code => `effect Held { hold(v: any): any; }\nexport const value = handle Held { hold: v => v } in { perform Held.hold(${code}) };` },
      ],
      statement: [{ wrap: code => `effect Hold { hold(): void; }\nexport const value = handle Hold { hold() {} } in { ${code} 3; };` }],
    },
  },
  typeclasses: {
    scopes: true,
    offers: {
      expression: [{
        prelude: "typeclass Three<A> { three(a: A): number; }\nimpl NumberThree = Three<number> { three(a) { return a; } }",
        code: "Three.three(3)",
      }],
    },
    holds: {
      expression: [{ wrap: code => `typeclass Hold<A> { hold(a: A): any; }\nimpl NumberHold = Hold<number> { hold(a) { return ${code}; } }\nexport const value = Hold.hold(0);` }],
      statement: [{ wrap: code => `typeclass Hold<A> { hold(a: A): void; }\nimpl NumberHold = Hold<number> { hold(a) {} }\nfunction held<T>(v: T) where <Hold<T>>: number { ${code} return 3; }\nexport const value = held(0);` }],
    },
  },
  "static-interface-members": {
    offers: {
      statement: [{ code: "interface Local { static make(): number; }" }],
    },
    holds: {
      type: [{
        wrap: type => `export interface Made { static make(): ${type}; }\nclass Maker implements Made { static make() { return 3 as const; } }\nexport const value = Maker.make();`,
        bad: type => `export interface Made { static make(): ${type}; }\nexport class Maker implements Made { static make() { return "x"; } }`,
        declares: true,
      }],
    },
  },
  "type-computation": {
    reaches: [{ prelude: "const tag = reify number;", wrap: hole => `typecase tag { number => ${hole}, _ => 0 }` }],
    offers: {
      expression: [{ prelude: "const offered = reify number;", code: "typecase offered { number => 3, _ => 0 }" }],
      type: [{ code: "let T = number in T" }, { code: "Succ<Succ<Succ<Zero>>>" }],
      statement: [{ code: "type Local: Type => Type = <X> =>> X[];" }],
    },
    holds: {
      expression: [{ wrap: code => `const tag = reify number;\nexport const value = typecase tag { number => ${code}, _ => 0 };` }],
    },
  },
};

const packageDirectories = new Map(allPlugins().map(({ packageDirectory }) => [path.basename(packageDirectory), packageDirectory]));
assert.deepEqual([...packageDirectories.keys()].sort(), Object.keys(features).sort(), "Describe every plugin in `features`.");

/** What a pairing writes, by the two plugins it needs: every offer of one in every place of the other. */
function casesByPair() {
  const pairs = new Map();
  for (const [holder, { holds }] of Object.entries(features)) {
    for (const [offerer, { offers }] of Object.entries(features)) {
      if (holder === offerer) continue;
      const key = [holder, offerer].sort().join(" + ");
      for (const kind of Object.keys(holds)) {
        for (const offer of offers[kind] ?? []) {
          for (const place of holds[kind]) {
            if (!pairs.has(key)) pairs.set(key, []);
            const prelude = offer.prelude ? `${offer.prelude}\n` : "";
            pairs.get(key).push({
              title: `${offerer} ${kind} \`${offer.code}\` in ${holder}`,
              good: `${prelude}${place.wrap(offer.code)}\n`,
              bad: place.bad && `${prelude}${place.bad(offer.code)}\n`,
              kept: place.declares ? offer.code : undefined,
              mayRefuse: place.mayRefuse,
            });
          }
        }
      }
    }
  }
  // A section holds what it finds holes in, so the other plugins say how far a hole reaches.
  for (const [holder, { holds, reaches, scopes }] of Object.entries(features)) {
    if (holder === "operator-sections" || !holds.expression) continue;
    assert.ok(reaches || scopes, `Say in \`reaches\` or \`scopes\` whether a hole reaches through ${holder}.`);
    if (!reaches?.length) continue;
    const key = [holder, "operator-sections"].sort().join(" + ");
    if (!pairs.has(key)) pairs.set(key, []);
    for (const { prelude, wrap } of reaches) {
      pairs.get(key).push({
        title: `a hole through ${holder}: \`${wrap("_ + 1")}\``,
        good: `${prelude ? `${prelude}\n` : ""}const section = (${wrap("_ + 1")});\nexport const value = section(2);\n`,
      });
    }
  }
  return pairs;
}

function compilePair(key, cases) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-nesting-"));
  try {
    const source = path.join(directory, "src");
    fs.mkdirSync(source);
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    const set = key.split(" + ");
    for (const name of set) fs.symlinkSync(packageDirectories.get(name), path.join(scope, `plugin-${name}`), "junction");
    cases.forEach((item, index) => {
      fs.writeFileSync(path.join(source, `good${index}.tspp`), item.good);
      if (item.bad) fs.writeFileSync(path.join(source, `bad${index}.tspp`), item.bad);
    });
    fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "commonjs",
        outDir: "out",
        rootDir: "src",
        types: [],
        strict: true,
        noImplicitAny: false,
        skipLibCheck: true,
        declaration: true,
        plugins: set.map(name => ({ name: `@tspp/plugin-${name}`, tspp: true })),
      },
      include: ["src"],
    }));
    const compiled = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-p", "."], { cwd: directory, encoding: "utf8" });
    const lines = `${compiled.stdout}${compiled.stderr}`.split(/\r?\n/);
    const errorsIn = name => lines.filter(line => line.startsWith(`src/${name}.tspp`));
    const problems = [];
    assert.ok(lines.every(line => !/^\s+at /.test(line)), `${key} crashed\n${compiled.stdout}${compiled.stderr}`);
    cases.forEach((item, index) => {
      const errors = errorsIn(`good${index}`);
      if (item.mayRefuse && errors.length && errors.every(line => item.mayRefuse.test(line))) return;
      if (errors.length) return problems.push(`${item.title}:\n  ${item.good.trim()}\n  ${errors.join("\n  ")}`);
      if (item.bad && !errorsIn(`bad${index}`).length) problems.push(`${item.title}: its bad variant reports nothing:\n  ${item.bad.trim()}`);
      const ran = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(directory, "out", `good${index}.js`))}).value))`], { encoding: "utf8" });
      if (ran.status !== 0) problems.push(`${item.title}: did not run:\n  ${ran.stderr}`);
      else if (ran.stdout !== "3") problems.push(`${item.title}: evaluated to ${ran.stdout}:\n  ${item.good.trim()}`);
      if (item.kept) {
        const declarations = fs.readFileSync(path.join(directory, "out", `good${index}.d.tspp`), "utf8");
        if (!declarations.includes(item.kept)) problems.push(`${item.title}: the declaration lost it:\n  ${declarations.trim()}`);
      }
    });
    assert.deepEqual(problems, []);
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const [key, cases] of casesByPair()) test(`${key} (${cases.length} nestings)`, () => compilePair(key, cases));
