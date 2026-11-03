// Every plugin alone, every pair, every set without one plugin, and all of them, through the real command line: tsconfig
// resolution, macro workers, analyzers, emit. In-process tests share one registry that only ever grows, so they miss
// what a partial plugin set breaks, and they never reach the worker. Each case also states the errors it must report,
// because a plugin that swallowed another's syntax would report nothing.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { allPlugins } = require("./plugins.cjs");

const compiler = path.dirname(require.resolve("ts-plus-plus/package.json"));
const tsc = path.join(compiler, "built", "local", "tsc.js");

const macro = `macro function named([target], context) {
  const name = target.name + "Name";
  return context.factory.createVariableStatement(undefined, context.factory.createVariableDeclarationList([
    context.factory.createVariableDeclaration(name, undefined, undefined, context.factory.createStringLiteral(target.name))]));
}`;

/**
 * What each plugin adds to a project: code that needs it, the values the code exports when run, an error it must report,
 * and optionally a declaration that macros must be able to target, written with its syntax.
 */
const features = {
  "formal-verification": {
    code: "export function proved(v: bigint) with { requires: v >= 0n; ensures: result >= 0n; }: bigint { return v; }\nexport const fv = 1;",
    expected: { fv: 1 },
    bad: "export function refuted(v: bigint) with { ensures: result >= 5n; }: bigint { return v; }",
    message: /refuted postcondition could not be proved/,
  },
  "modern-syntax": {
    code: "export const modern = do { const a = let b = 2 in b + 1; a * 2 };",
    expected: { modern: 6 },
    bad: "export const badDo: string = do { 1 };",
    message: /not assignable to type 'string'/,
  },
  "nominal-types": {
    code: "data Nom = NomA(x: number) | NomB;\nconst box: { nom: Nom } = { nom: NomA(3) };\nexport const nominal = match box.nom { NomA(x) => x, NomB => 0 };",
    expected: { nominal: 3 },
    bad: "data Bad = BadA | BadB;\nexport function badMatch(b: { v: Bad }) { return match b.v { BadA => 1 }; }",
    message: /Non-exhaustive match\. Missing patterns: BadB/,
    target: "Nom",
  },
  "operator-sections": {
    code: "export const section = [1].map((_ + 1));",
    expected: { section: [2] },
    bad: "export const badSection: string = (_ + 1);",
    message: /not assignable to type 'string'/,
  },
  "static-interface-members": {
    code: "interface Stat { static make(): number; }\nclass StatImpl implements Stat { static make() { return 4; } }\nexport const statics = StatImpl.make();",
    expected: { statics: 4 },
    bad: "interface BadStat { static make(): number; }\nexport class BadImpl implements BadStat {}",
    message: /incorrectly implements static side/,
    target: "Stat",
  },
  "type-computation": {
    code: 'type Lst: Type => Type = <A> =>> A[];\nconst list: Lst<number> = [5];\nconst d = reify number;\nexport const computed = [list[0], typecase d { number => "n", _ => "o" }];',
    expected: { computed: [5, "n"] },
    bad: 'type BadLst: Type => Type = <A> =>> A[];\nexport const badList: BadLst<number> = "x";',
    message: /not assignable to type 'number\[\]'/,
    target: "Lst",
  },
  macros: {
    code: `${macro}\ninterface Plain { a: number }\nmacro named(Plain);\nexport const macros = PlainName;`,
    expected: { macros: "Plain" },
    bad: "macro named(Missing);",
    message: /Target 'Missing' could not be resolved/,
  },
};

const packageDirectories = new Map(allPlugins().map(({ packageDirectory }) => [path.basename(packageDirectory), packageDirectory]));
const installed = [...packageDirectories.keys()];
assert.deepEqual([...installed].sort(), Object.keys(features).sort(), "Describe every plugin in `features`.");

function pluginSets() {
  const names = [...installed].sort();
  const sets = new Map();
  const add = set => sets.set(set.join("+"), set);
  for (const name of names) {
    add([name]);
    add(names.filter(other => other !== name));
  }
  names.forEach((first, index) => names.slice(index + 1).forEach(second => add([first, second])));
  add(names);
  return [...sets.values()];
}

function compileAndRun(set) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-cli-"));
  try {
    const source = path.join(directory, "src");
    fs.mkdirSync(source);
    // A project resolves its plugins from its own node_modules, which holds exactly this set.
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    for (const name of set) fs.symlinkSync(packageDirectories.get(name), path.join(scope, `plugin-${name}`), "junction");
    const parts = set.map(name => features[name]);
    // Macros reach every declaration the other plugins let a project write.
    const targeted = set.includes("macros") ? parts.flatMap(part => part.target ? [part.target] : []) : [];
    const expected = Object.assign({}, ...parts.map(part => part.expected), ...targeted.map(target => ({ [`${target}Name`]: target })));
    const good = [...parts.map(part => part.code), ...targeted.map(target => `macro named(${target});\nexport { ${target}Name };`)].join("\n");
    const needsMacro = set.includes("macros") ? `${macro}\n` : "";
    fs.writeFileSync(path.join(source, "good.tspp"), `${good}\n`);
    fs.writeFileSync(path.join(source, "bad.tspp"), `${needsMacro}${parts.map(part => part.bad).join("\n")}\nexport {};\n`);
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
        plugins: set.map(name => ({ name: `@tspp/plugin-${name}`, tspp: true })),
      },
      include: ["src"],
    }));
    const compiled = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-p", "."], { cwd: directory, encoding: "utf8" });
    const lines = compiled.stdout.split(/\r?\n/).filter(line => /error TS/.test(line));
    const unexpected = lines.filter(line => !line.startsWith("src/bad.tspp"));
    assert.deepEqual(unexpected, [], `errors outside bad.tspp with ${set.join(" + ")}\n${compiled.stdout}${compiled.stderr}`);
    for (const part of parts) assert.match(compiled.stdout, part.message, `${set.join(" + ")} lost an error\n${compiled.stdout}${compiled.stderr}`);
    assert.equal(compiled.status, 2, `${set.join(" + ")}\n${compiled.stdout}${compiled.stderr}`);
    const ran = spawnSync(process.execPath, ["-e", `process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(directory, "out", "good.js"))})))`], { encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.deepEqual(JSON.parse(ran.stdout), expected);
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const set of pluginSets()) test(set.join(" + "), () => compileAndRun(set));

test("solution builds load each project's plugins and do not call a refuted project up to date", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-cli-"));
  try {
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    for (const name of ["formal-verification", "nominal-types"]) fs.symlinkSync(packageDirectories.get(name), path.join(scope, `plugin-${name}`), "junction");
    const project = (name, plugin, source, references = []) => {
      fs.mkdirSync(path.join(directory, name, "src"), { recursive: true });
      fs.symlinkSync(path.join(directory, "node_modules"), path.join(directory, name, "node_modules"), "junction");
      fs.writeFileSync(path.join(directory, name, "src", "index.tspp"), source);
      fs.writeFileSync(path.join(directory, name, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "commonjs", outDir: "out", rootDir: "src", types: [], strict: true, skipLibCheck: true, composite: true, plugins: [{ name: `@tspp/plugin-${plugin}`, tspp: true }] },
        include: ["src"],
        references,
      }));
    };
    project("data", "nominal-types", "export data Flag = On | Off;\n");
    project("proof", "formal-verification", `${features["formal-verification"].bad}\n`, [{ path: "../data" }]);
    fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "data" }, { path: "proof" }] }));
    for (let run = 0; run < 2; run++) {
      const built = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-b"], { cwd: directory, encoding: "utf8" });
      assert.match(built.stdout, features["formal-verification"].message, `run ${run}\n${built.stdout}${built.stderr}`);
      assert.notEqual(built.status, 0, `run ${run}\n${built.stdout}${built.stderr}`);
      assert.doesNotMatch(built.stdout, /error TS1\d\d\d:/, `run ${run}: syntax errors mean a plugin did not load\n${built.stdout}`);
    }
    fs.writeFileSync(path.join(directory, "proof", "src", "index.tspp"), `${features["formal-verification"].code}\n`);
    const fixed = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-b"], { cwd: directory, encoding: "utf8" });
    assert.equal(fixed.status, 0, `${fixed.stdout}${fixed.stderr}`);
    assert.ok(fs.existsSync(path.join(directory, "data", "out", "index.d.tspp")));
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a project of a solution build sees only its own plugins, whatever was built before it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-cli-"));
  try {
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    for (const name of ["formal-verification", "nominal-types"]) fs.symlinkSync(packageDirectories.get(name), path.join(scope, `plugin-${name}`), "junction");
    const project = (name, plugins, source, references = []) => {
      fs.mkdirSync(path.join(directory, name, "src"), { recursive: true });
      fs.symlinkSync(path.join(directory, "node_modules"), path.join(directory, name, "node_modules"), "junction");
      fs.writeFileSync(path.join(directory, name, "src", "index.tspp"), source);
      fs.writeFileSync(path.join(directory, name, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "commonjs", outDir: "out", rootDir: "src", types: [], strict: true, skipLibCheck: false, composite: true, plugins: plugins.map(plugin => ({ name: `@tspp/plugin-${plugin}`, tspp: true })) },
        include: ["src"],
        references: references.map(reference => ({ path: `../${reference}` })),
      }));
    };
    const reading = `import type { Flag } from "../../data/src/index";\nexport type Read = Flag;\n`;
    project("data", ["nominal-types"], "export data Flag = On | Off;\n");
    project("user", ["nominal-types"], reading, ["data"]);
    project("reader", [], reading, ["data"]);
    project("plain", [], "export data Leak = A | B;\n");
    project("proof", ["formal-verification"], `${features["formal-verification"].bad}\n`);
    project("after", [], "export const after = 1;\n");
    const build = order => {
      for (const name of order) {
        fs.rmSync(path.join(directory, name, "out"), { recursive: true, force: true });
        fs.rmSync(path.join(directory, name, "tsconfig.tsbuildinfo"), { force: true });
      }
      fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({ files: [], references: order.map(name => ({ path: name })) }));
      const built = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-b"], { cwd: directory, encoding: "utf8" });
      return { ...built, errors: built.stdout.split(/\r?\n/).filter(line => /error TS/.test(line)).sort() };
    };
    const first = build(["proof", "data", "user", "reader", "plain", "after"]);
    assert.match(first.stdout, /plain\/src\/index\.tspp\(1,\d+\): error TS1\d\d\d:/, `a project without the plugin must not read its syntax\n${first.stdout}${first.stderr}`);
    assert.match(first.stdout, /data\/out\/index\.d\.tspp\(1,\d+\): error TS1\d\d\d:/, `a project without the plugin must not read its declaration syntax\n${first.stdout}${first.stderr}`);
    assert.match(first.stdout, features["formal-verification"].message, `an analyzer did not run under its project's plugins\n${first.stdout}${first.stderr}`);
    assert.ok(!first.errors.some(line => /^(data\/src|after)\//.test(line) || /^user\/.*error TS1\d\d\d:/.test(line)), first.errors.join("\n"));
    assert.notEqual(first.status, 0);
    const second = build(["after", "plain", "reader", "data", "user", "proof"]);
    assert.deepEqual(second.errors, first.errors, "the build order changed the result");
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// Upstream's builder programs emit on their own path: an analyzer's errors must still reach the status and the output.
for (const mode of [{ incremental: true, tsBuildInfoFile: "out.tsbuildinfo" }, { composite: true, rootDir: "src" }]) {
  test(`analyzers run in ${Object.keys(mode)[0]} compilations`, () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-cli-"));
    try {
      fs.mkdirSync(path.join(directory, "src"));
      const scope = path.join(directory, "node_modules", "@tspp");
      fs.mkdirSync(scope, { recursive: true });
      fs.symlinkSync(packageDirectories.get("formal-verification"), path.join(scope, "plugin-formal-verification"), "junction");
      fs.writeFileSync(path.join(directory, "src", "a.tspp"), features["formal-verification"].bad + "\n");
      fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "commonjs", outDir: "out", types: [], strict: true, skipLibCheck: true, ...mode, plugins: [{ name: "@tspp/plugin-formal-verification", tspp: true }] },
        include: ["src"],
      }));
      for (let run = 0; run < 2; run++) {
        const compiled = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-p", "."], { cwd: directory, encoding: "utf8" });
        assert.match(compiled.stdout, features["formal-verification"].message, `run ${run}\n${compiled.stdout}${compiled.stderr}`);
        assert.equal(compiled.status, 2, `run ${run}\n${compiled.stdout}${compiled.stderr}`);
      }
    }
    finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}
