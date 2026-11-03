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
    assert.doesNotMatch(first.stdout, /\.d\.tspp\(/, `a project without the plugin reads the compatible declarations\n${first.stdout}${first.stderr}`);
    assert.ok(!first.errors.some(line => line.startsWith("reader/")), first.errors.join("\n"));
    assert.match(fs.readFileSync(path.join(directory, "data", "out", "index.d.tspp"), "utf8"), /^\/\/ @tspp-plugins nominal-types\r?\n/);
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

test("a project built from TS++ declarations stays buildable as its sources change", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-cli-"));
  try {
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(packageDirectories.get("nominal-types"), path.join(scope, "plugin-nominal-types"), "junction");
    const project = (name, source, references = []) => {
      fs.mkdirSync(path.join(directory, name, "src"), { recursive: true });
      fs.symlinkSync(path.join(directory, "node_modules"), path.join(directory, name, "node_modules"), "junction");
      fs.writeFileSync(path.join(directory, name, "src", "index.tspp"), source);
      fs.writeFileSync(path.join(directory, name, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "commonjs", outDir: "out", rootDir: "src", types: [], strict: true, composite: true, plugins: [{ name: "@tspp/plugin-nominal-types", tspp: true }] },
        include: ["src"],
        references: references.map(reference => ({ path: `../${reference}` })),
      }));
    };
    const library = `export data Flag = On | Off;
export newtype Id = number;
export data Opt<T> = None | Some(value: T);
export const on: Flag = On;
export function name(f: Flag): string { return match f { On => "on", Off => "off" }; }
`;
    const consumer = `import { type Flag, type Opt, on, name, Some, None } from "../../library/src/index";
export const label: string = name(on);
export const flag: Flag = on;
const held: Opt<number> = Some(1);
export const value = match held { Some(value) => value + 1, None => 0 };
`;
    project("library", library);
    project("consumer", consumer, ["library"]);
    fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({ files: [], references: [{ path: "library" }, { path: "consumer" }] }));
    const build = args => spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, ...args], { cwd: directory, encoding: "utf8" });
    const built = build(["-b"]);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    assert.ok(fs.existsSync(path.join(directory, "library", "out", "index.d.tspp")));
    assert.ok(!fs.existsSync(path.join(directory, "consumer", "out", "library")), "a referenced project's declarations must not be emitted again");
    // Both projects' signatures change, which is where the builder reads the declaration files it emitted.
    fs.appendFileSync(path.join(directory, "library", "src", "index.tspp"), "export const added = 1;\n");
    fs.appendFileSync(path.join(directory, "consumer", "src", "index.tspp"), "export const more = 2;\n");
    const rebuilt = build(["-b"]);
    assert.equal(rebuilt.status, 0, `${rebuilt.stdout}${rebuilt.stderr}`);
    fs.appendFileSync(path.join(directory, "library", "src", "index.tspp"), "export const again = 3;\n");
    const single = build(["-p", "library"]);
    assert.equal(single.status, 0, `${single.stdout}${single.stderr}`);
    // A declaration still reports what its consumer gets wrong.
    fs.appendFileSync(path.join(directory, "consumer", "src", "index.tspp"), "export const bad: Flag = 1;\n");
    const wrong = build(["-b"]);
    assert.match(wrong.stdout, /consumer\/src\/index\.tspp\(\d+,\d+\): error TS2322/, `${wrong.stdout}${wrong.stderr}`);
    assert.doesNotMatch(wrong.stdout, /\.d\.tspp\(/, wrong.stdout);
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a TS++ file lacking a plugin of its dependency reads the compatible declarations, by design", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-cli-"));
  try {
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    for (const name of ["nominal-types", "modern-syntax", "type-computation"]) fs.symlinkSync(packageDirectories.get(name), path.join(scope, `plugin-${name}`), "junction");
    const compile = (cwd, plugins, extra = {}) => {
      fs.writeFileSync(path.join(cwd, "tsconfig.json"), JSON.stringify({
        compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", outDir: "out", rootDir: "src", types: [], strict: true, declaration: true, plugins: plugins.map(plugin => ({ name: `@tspp/plugin-${plugin}`, tspp: true })), ...extra },
        include: ["src"],
      }));
      return spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-p", "."], { cwd, encoding: "utf8" });
    };
    // A package, as other projects install it: its types through both `tsppTypes` and the `tspp-types` condition.
    const library = path.join(directory, "node_modules", "library");
    fs.mkdirSync(path.join(library, "src"), { recursive: true });
    fs.writeFileSync(path.join(library, "src", "index.tspp"), `export data Flag = On | Off;
export interface Holds<F: Type => Type> { items: F<number>; }
export const flag: Flag = On;
`);
    fs.writeFileSync(path.join(library, "package.json"), JSON.stringify({
      name: "library", type: "module", tsppTypes: "./out/index.d.tspp", types: "./out/index.d.ts",
      exports: { ".": { "tspp-types": "./out/index.d.tspp", types: "./out/index.d.ts", default: "./out/index.js" } },
    }));
    fs.symlinkSync(path.join(directory, "node_modules"), path.join(library, "node_modules"), "junction");
    const built = compile(library, ["nominal-types", "type-computation"]);
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    assert.match(fs.readFileSync(path.join(library, "out", "index.d.tspp"), "utf8"), /^\/\/ @tspp-plugins nominal-types,type-computation\r?\n/);

    const consumer = (name, plugins, source) => {
      const root = path.join(directory, name);
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.symlinkSync(path.join(directory, "node_modules"), path.join(root, "node_modules"), "junction");
      fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(path.join(root, "src", "index.tspp"), source);
      const result = compile(root, plugins);
      return `${result.stdout}${result.stderr}`;
    };
    // No plugin, or only some of them: never a syntax error in the library, and the types still hold.
    const lowered = `import { flag, type Flag, type Holds } from "library";
export const held: Flag = flag;
export const holds: Holds<unknown> = { items: 1 };
export const wrong: Flag = 1;
`;
    for (const [name, plugins] of [["none", []], ["some", ["nominal-types"]], ["other", ["modern-syntax"]]]) {
      const output = consumer(name, plugins, lowered);
      assert.doesNotMatch(output, /\.d\.tspp/, `${name}\n${output}`);
      assert.deepEqual(output.split(/\r?\n/).filter(line => /error TS/.test(line)).map(line => /error (TS\d+)/.exec(line)[1]), ["TS2322"], `${name}\n${output}`);
    }
    // Every plugin, with more besides: the declaration keeps its kinds, so a type constructor is an argument. Without
    // them it is a generic type with no arguments.
    const kinded = `import { flag, type Flag, type Holds } from "library";
export const held: Flag = flag;
export const holds: Holds<Array> = { items: [1] };
`;
    const all = consumer("all", ["nominal-types", "type-computation", "modern-syntax"], kinded);
    assert.deepEqual(all.split(/\r?\n/).filter(line => /error TS/.test(line)), [], all);
    assert.match(consumer("partial", ["nominal-types"], kinded), /error TS2314/);
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a project finds plugins installed above it, however -p names it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-cli-"));
  try {
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    fs.symlinkSync(packageDirectories.get("nominal-types"), path.join(scope, "plugin-nominal-types"), "junction");
    const project = path.join(directory, "workspace", "project");
    fs.mkdirSync(path.join(project, "src"), { recursive: true });
    fs.writeFileSync(path.join(project, "src", "a.tspp"), `${features["nominal-types"].code}\n`);
    fs.writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "es2022", module: "commonjs", noEmit: true, types: [], strict: true, skipLibCheck: true, plugins: [{ name: "@tspp/plugin-nominal-types", tspp: true }] },
      include: ["src"],
    }));
    for (const [cwd, name] of [[project, "."], [project, "tsconfig.json"], [path.dirname(project), "project"], [directory, project]]) {
      const compiled = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-p", name], { cwd, encoding: "utf8" });
      assert.equal(compiled.status, 0, `-p ${name} from ${cwd}\n${compiled.stdout}${compiled.stderr}`);
    }
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
