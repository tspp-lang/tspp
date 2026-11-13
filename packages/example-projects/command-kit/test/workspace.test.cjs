const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const { bin } = require('../package.json');
const entry = resolve(__dirname, '..', bin['command-kit']);

function execute(argv, env = {}) {
  const environment = { ...process.env, ...env };
  delete environment.COMMAND_KIT_LIMIT;
  Object.assign(environment, env);
  return spawnSync(process.execPath, [entry, ...argv], {
    encoding: 'utf8', env: environment, timeout: 10000,
  });
}

test('workspace CLI reads real manifests, filters names, and resolves local dependencies', () => {
  const prefix = join(tmpdir(), 'tspp-command-kit-');
  const root = mkdtempSync(prefix);
  const manifest = (directory, data) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(data));
  };
  try {
    manifest(root, { name: 'workspace', version: '1.0.0' });
    manifest(join(root, 'packages/a'), { name: '@workspace/a', version: '1.2.0', dependencies: { '@workspace/b': 'workspace:*', external: '*' } });
    manifest(join(root, 'packages/group/b'), { name: '@workspace/b', version: '2.0.0' });
    manifest(join(root, 'packages/a/node_modules/ignored'), { name: 'ignored' });

    const list = execute(['list', root, '--json', '--scope', '@workspace/']);
    assert.equal(list.status, 0, list.stderr);
    const items = JSON.parse(list.stdout);
    assert.deepEqual(items.map(item => item.name), ['@workspace/a', '@workspace/b']);
    assert.equal(items[0].directory, 'packages/a');
    assert.equal(items[1].directory, 'packages/group/b');

    const deps = execute(['--json', 'deps', '@workspace/a', root]);
    assert.equal(deps.status, 0, deps.stderr);
    assert.deepEqual(JSON.parse(deps.stdout), ['@workspace/b']);

    const limited = execute(['list', root, '--json'], { COMMAND_KIT_LIMIT: '1' });
    assert.equal(limited.status, 0, limited.stderr);
    assert.equal(JSON.parse(limited.stdout).length, 1);

    const invalid = execute(['list', root, '--limit', '0']);
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /greater than zero/);

    const missing = execute(['deps', '@workspace/missing', root]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Package not found/);

    writeFileSync(join(root, 'packages/a/package.json'), '{ malformed');
    const malformed = execute(['list', root]);
    assert.equal(malformed.status, 1);
    assert.ok(malformed.stderr.length > 0);
  } finally {
    if (!resolve(root).startsWith(resolve(prefix))) throw new Error('Unexpected test directory');
    rmSync(root, { recursive: true, force: true });
  }
});

test('workspace CLI exposes root help without requiring a command', () => {
  const result = execute([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: command-kit/);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /deps/);
});
