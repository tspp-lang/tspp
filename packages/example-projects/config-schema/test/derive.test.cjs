// `deriveSchema` runs while a consumer compiles, so these tests compile the consumer in `fixture`, which imports this
// package by name as other projects do, and then use the schema it generated.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const s = require('../dist/index.js');

const fixture = path.join(__dirname, 'fixture');
const tspp = path.join(path.dirname(require.resolve('ts-plus-plus/package.json')), 'bin', 'tspp');

/** Compiles a project and returns its diagnostics; an empty string means it compiled. */
function compile(project) {
  try {
    execFileSync(process.execPath, [tspp, '--compile', '-p', project, '--pretty', 'false'], { encoding: 'utf8', stdio: 'pipe' });
    return '';
  }
  catch (error) {
    return `${error.stdout}${error.stderr}`;
  }
}

test('a derived schema decodes and explains what its interface describes', () => {
  assert.equal(compile(path.join(fixture, 'tsppconfig.json')), '');
  const { SettingsSchema } = require('./fixture/dist/settings.js');
  const endpoint = { url: 'https://a.example', timeout: '5s' };
  const settings = SettingsSchema.parse({
    name: 'api',
    port: 8080,
    level: 'warn',
    verbose: false,
    tags: ['x'],
    upstreams: { main: endpoint },
    fallback: null,
    database: { url: 'postgres://db', pool: [1, 2] },
  });
  assert.equal(settings.port.number, 8080);
  assert.equal(settings.upstreams.main.timeout.milliseconds, 5_000);
  assert.equal('host' in settings, false);

  const rejected = SettingsSchema.decode({ name: 'api', port: 80, level: 'loud', verbose: false, tags: [], upstreams: {}, fallback: {}, database: {} });
  assert.deepEqual(rejected.issues.map(s.formatIssue), [
    'level: expected one of "debug", "info", "warn", "error", got "loud"',
    'fallback.url: missing required key',
    'database.url: missing required key',
    'database.pool: missing required key',
  ]);

  assert.deepEqual(s.explain(SettingsSchema).map(setting => [setting.path, setting.optional, setting.description ?? null]), [
    ['name', false, 'The name shown in logs.'],
    ['port', false, null],
    ['host', true, null],
    ['level', false, null],
    ['retries', true, null],
    ['verbose', false, null],
    ['tags', false, null],
    ['upstreams.*.url', false, null],
    ['upstreams.*.timeout', true, 'How long to wait for a response.'],
    ['fallback', false, null],
    ['database.url', false, null],
    ['database.pool', false, null],
  ]);
});

const rejections = [
  ['a method', 'interface Bad { run(): void }', "Bad: only properties can be read from configuration, not 'run(): void'"],
  ['a mutable array', 'interface Bad { list: string[] }', "Bad.list: arrays from configuration are frozen; write 'readonly string[]'"],
  ['an undefined value without ?', 'interface Bad { a: string | undefined }', "Bad.a: configuration has no undefined values; write 'a?:' for a key that may be missing"],
  ['a recursive type', 'interface Bad { child?: Bad }', "Bad.child: 'Bad' contains itself, which configuration cannot"],
  ['a generic type', 'interface Box<T> { value: T }\ninterface Bad { box: Box<string> }', "Bad.box: no schema describes the type 'Box<string>'"],
  ['a type with no schema', 'interface Bad { when: Date; }', "Bad.when: no schema describes the type 'Date', which has members other than properties such as 'toString(): string;'"],
  ['a class', 'class Bad {}', 'deriveSchema needs an interface or a type alias; use of(Bad) for a ConfigValue class'],
];

test('deriveSchema explains the types it cannot describe', () => {
  const project = fs.mkdtempSync(path.join(fixture, '.rejected-'));
  try {
    fs.mkdirSync(path.join(project, 'src'));
    fs.writeFileSync(path.join(project, 'tsppconfig.json'), JSON.stringify({
      extends: '../tsppconfig.json',
      compilerOptions: { noEmit: true, rootDir: 'src' },
      include: ['src/**/*.tspp'],
    }));
    rejections.forEach(([, declaration], index) => fs.writeFileSync(
      path.join(project, 'src', `case${index}.tspp`),
      `import { deriveSchema } from "@tspp/config-schema";\n${declaration}\nmacro deriveSchema(Bad);\n`,
    ));
    const output = compile(path.join(project, 'tsppconfig.json'));
    rejections.forEach(([name, , message], index) => {
      const line = output.split('\n').find(text => text.includes(`case${index}.tspp`));
      assert.ok(line?.includes(message), `${name}: ${line ?? output}`);
    });
  }
  finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});
