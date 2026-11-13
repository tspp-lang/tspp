const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { selectAddresses, formatAddresses, runApplication } = require('../dist');

const interfaces = {
  zeta: [
    { family: 'IPv6', address: 'fe80::b%zeta', internal: false },
    { family: 'IPv4', address: '10.0.0.2', internal: false },
    { family: 'IPv4', address: '127.0.0.1', internal: true },
  ],
  Alpha: [
    { family: 'IPv6', address: 'fe80::a%Alpha', internal: false },
    { family: 'IPv4', address: '192.168.1.2', internal: false },
    { family: 'IPv4', address: '192.168.1.1', internal: false },
  ],
  empty: [],
};

function invoke(argv, reader = () => interfaces) {
  const out = [], err = [];
  const status = runApplication({ argv, readInterfaces: reader, stdout: value => out.push(value), stderr: value => err.push(value) });
  return { status, out, err };
}

test('selection filters and orders interfaces, families and addresses', () => {
  const result = selectAddresses(interfaces);
  assert.deepEqual(result.map(x => [x.interface, x.family, x.address]), [
    ['Alpha', 'IPv4', '192.168.1.1'], ['Alpha', 'IPv4', '192.168.1.2'],
    ['Alpha', 'IPv6', 'fe80::a%Alpha'], ['zeta', 'IPv4', '10.0.0.2'], ['zeta', 'IPv6', 'fe80::b%zeta'],
  ]);
  assert.deepEqual(selectAddresses(interfaces, { interface: 'zeta', family: 'ipv4', internal: true }).map(x => x.address), ['10.0.0.2', '127.0.0.1']);
  assert.deepEqual(selectAddresses(interfaces, { interface: 'Alpha', family: 'ipv6' }).map(x => x.address), ['fe80::a%Alpha']);
  assert.throws(() => selectAddresses(interfaces, { interface: 'alpha' }), /Interface not found/);
});

test('formatting returns JSON records and readable text', () => {
  const addresses = selectAddresses(interfaces, { interface: 'zeta', family: 'ipv6' });
  assert.deepEqual(JSON.parse(formatAddresses(addresses, true)), [{ interface: 'zeta', family: 'IPv6', address: 'fe80::b%zeta', internal: false }]);
  assert.equal(formatAddresses(addresses), 'zeta\tIPv6\tfe80::b%zeta\texternal');
  assert.equal(formatAddresses([]), 'No matching addresses.');
  assert.equal(formatAddresses([], true), '[]');
});

test('application uses real command parser and reports empty or missing interfaces', () => {
  const result = invoke(['zeta', '-f', 'ipv6', '-j']);
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.out[0]), [{ interface: 'zeta', family: 'IPv6', address: 'fe80::b%zeta', internal: false }]);
  assert.deepEqual(result.err, []);
  assert.deepEqual(invoke(['empty', '-j']), { status: 0, out: ['[]'], err: [] });
  assert.deepEqual(invoke([], () => ({})), { status: 0, out: ['No matching addresses.'], err: [] });
  const missing = invoke(['missing']);
  assert.equal(missing.status, 1);
  assert.deepEqual(missing.out, []);
  assert.match(missing.err[0], /Interface not found: missing/);
  assert.equal(invoke(['--family', 'bad']).status, 2);
});

test('help, version and invalid arguments avoid OS; read errors are reported', () => {
  const fail = () => { throw new Error('OS unavailable'); };
  for (const args of [['--help'], ['--version'], ['--family', 'bad']]) {
    assert.notEqual(invoke(args, fail).status, 1);
  }
  assert.deepEqual(invoke([], fail), { status: 1, out: [], err: ['OS unavailable'] });
  assert.throws(() => runApplication({ argv: [], readInterfaces: () => interfaces, stdout: () => { throw new Error('output failed'); } }), /output failed/);
});

test('bin handles help, version and invalid family', () => {
  const bin = path.join(__dirname, '../dist/cli.js');
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
  const help = run('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: local-ip/);
  assert.equal(help.stderr, '');
  const version = run('--version');
  assert.equal(version.status, 0);
  assert.match(version.stdout, /0\.0\.0/);
  assert.equal(version.stderr, '');
  const invalid = run('--family', 'bad');
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /error/);
});
