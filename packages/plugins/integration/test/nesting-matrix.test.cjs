// Each plugin's syntax written inside each other plugin's, through the real command line. `cli-matrix.test.cjs` puts
// plugins side by side, which shows they leave each other alone; this shows they compose. A plugin lists where it holds
// code (`holds`) and the code it offers (`offers`), and every pairing follows from those lists, so a new plugin adds one
// entry here and no test per pair. A pairing must compile, run to its value, and report the error of its `bad` variant;
// a place that `declares` must also keep the syntax it holds in its `.d.tspp`. A place that `mayRefuse` is verified code:
// lowered code outside what proofs can model may be refused with the verifier's own diagnostic, never misread or accepted
// silently. Only what a plugin can write anywhere is offered: `data` and `newtype` declare at the top level of a module.
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
  "formal-verification": {
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
