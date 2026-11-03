// The meaning of "plugins add up": a plugin a project's code does not use changes nothing. Each example also compiles
// with every plugin it does not declare, one at a time, and must report the same errors and emit the same JavaScript.
// This grows with plugins times examples, not with their combinations.
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { allPlugins, pluginsRoot } = require("./plugins.cjs");

const tsc = path.join(path.dirname(require.resolve("ts-plus-plus/package.json")), "built", "local", "tsc.js");
const examplesRoot = path.resolve(pluginsRoot, "..", "examples");
const packageDirectories = new Map(allPlugins().map(({ packageDirectory }) => [path.basename(packageDirectory), packageDirectory]));
const plugins = [...packageDirectories.keys()].sort();
// Imports another example's package, which a project of its own cannot resolve.
const skipped = new Set(["04-newtype-consumer"]);
const examples = fs.readdirSync(examplesRoot).filter(name => /^\d\d-/.test(name) && !skipped.has(name)).sort();

function filesUnder(directory, root = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? filesUnder(path.join(directory, entry.name), root) : [path.relative(root, path.join(directory, entry.name))]);
}

function compile(populate, set) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tspp-inert-"));
  try {
    populate(path.join(directory, "src"));
    const scope = path.join(directory, "node_modules", "@tspp");
    fs.mkdirSync(scope, { recursive: true });
    for (const name of set) fs.symlinkSync(packageDirectories.get(name), path.join(scope, `plugin-${name}`), "junction");
    fs.writeFileSync(path.join(directory, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "es2022", module: "commonjs", outDir: "out", rootDir: "src", types: [], strict: true, noImplicitAny: false, skipLibCheck: true,
        plugins: set.map(name => ({ name: `@tspp/plugin-${name}`, tspp: true })),
      },
      include: ["src"],
    }));
    const compiled = spawnSync(process.execPath, ["--max-old-space-size=1024", tsc, "-p", "."], { cwd: directory, encoding: "utf8" });
    const output = path.join(directory, "out");
    const javascript = fs.existsSync(output)
      ? Object.fromEntries(filesUnder(output).filter(file => file.endsWith(".js")).sort().map(file => [file, fs.readFileSync(path.join(output, file), "utf8")]))
      : {};
    return { errors: compiled.stdout.split(/\r?\n/).filter(line => /error TS/.test(line)).sort(), javascript };
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

for (const example of examples) {
  const tsconfig = fs.readFileSync(path.join(examplesRoot, example, "tsconfig.json"), "utf8");
  const declared = plugins.filter(name => tsconfig.includes(`@tspp/plugin-${name}"`));
  const populate = source => fs.cpSync(path.join(examplesRoot, example, "src"), source, { recursive: true });
  test(`${example} does not notice plugins it does not use`, () => {
    const base = compile(populate, declared);
    for (const extra of plugins.filter(name => !declared.includes(name))) {
      const got = compile(populate, [...declared, extra]);
      assert.deepEqual(got.errors, base.errors, `errors changed with ${extra}`);
      assert.deepEqual(got.javascript, base.javascript, `JavaScript changed with ${extra}`);
    }
  });
}

// A keyword is a keyword only where its plugin parses it. Written where TypeScript takes any word as a name, every keyword a
// manifest lists must leave the program as it was, whatever the plugin does to find its syntax.
const memberNames = word => `export interface Interface${word.id} { ${word.text}: boolean; name: string; }
export const value${word.id}: Interface${word.id} = { ${word.text}: true, name: "x" };
export type Alias${word.id} = { ${word.text}: number; other: { ${word.text}: string; }; };
export const alias${word.id}: Alias${word.id} = { ${word.text}: 1, other: { ${word.text}: "y" } };
export class Class${word.id} { ${word.text} = 1; }
export const read${word.id} = [value${word.id}.${word.text}, alias${word.id}.other.${word.text}, new Class${word.id}().${word.text}];
`;

for (const { packageDirectory, plugin } of allPlugins()) {
  const name = path.basename(packageDirectory);
  const words = [...new Set((plugin.manifest.syntax?.keywords ?? []).map(({ keyword }) => keyword))].filter(word => /^[A-Za-z_$][\w$]*$/.test(word));
  if (!words.length) continue;
  test(`the keywords of ${name} stay ordinary member names`, () => {
    const populate = source => {
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "names.tspp"), words.map((text, id) => memberNames({ text, id })).join("\n"));
    };
    const base = compile(populate, []);
    assert.deepEqual(base.errors, []);
    const got = compile(populate, [name]);
    assert.deepEqual(got.errors, base.errors);
    assert.deepEqual(got.javascript, base.javascript);
  });
}
