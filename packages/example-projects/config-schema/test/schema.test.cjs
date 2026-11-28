const assert = require('node:assert/strict');
const { test } = require('node:test');
const s = require('../dist/index.js');

const messages = decoded => {
  assert.equal(decoded._tag, 'Invalid');
  return decoded.issues.map(s.formatIssue);
};
const valueOf = decoded => {
  assert.equal(decoded._tag, 'Valid', decoded.issues?.map(s.formatIssue).join('\n'));
  return decoded.value;
};

test('scalar schemas accept their own values and describe what they rejected', () => {
  assert.equal(valueOf(s.string().decode('a')), 'a');
  assert.equal(valueOf(s.number().decode(1.5)), 1.5);
  assert.equal(valueOf(s.integer().decode(-3)), -3);
  assert.equal(valueOf(s.boolean().decode(false)), false);
  assert.deepEqual(messages(s.string().decode(1)), ['<root>: expected a string, got 1']);
  assert.deepEqual(messages(s.number().decode(Number.NaN)), ['<root>: expected a finite number, got NaN']);
  assert.deepEqual(messages(s.integer().decode(1.5)), ['<root>: expected an integer, got 1.5']);
  assert.deepEqual(messages(s.boolean().decode('yes')), ['<root>: expected true or false, got "yes"']);
  assert.deepEqual(messages(s.integer().decode('x'.repeat(50))), [`<root>: expected an integer, got "${'x'.repeat(37)}..."`]);
});

test('oneOf and literal accept exactly the listed values', () => {
  const level = s.oneOf('debug', 'info', null);
  assert.equal(valueOf(level.decode('info')), 'info');
  assert.equal(valueOf(level.decode(null)), null);
  assert.deepEqual(messages(level.decode('warn')), ['<root>: expected one of "debug", "info", null, got "warn"']);
  assert.deepEqual(messages(s.literal(1).decode(2)), ['<root>: expected 1, got 2']);
});

test('objects report every missing, invalid, and unknown key at its path', () => {
  const schema = s.object({
    port: s.integer(),
    level: s.string(),
    servers: s.array(s.object({ name: s.string() })),
  });
  assert.deepEqual(messages(schema.decode({ prot: 1, level: 2, servers: [{ name: 'a' }, {}, { name: 3 }], extra: true })), [
    'port: missing required key',
    'level: expected a string, got 2',
    'servers[1].name: missing required key',
    'servers[2].name: expected a string, got 3',
    'prot: unknown key; did you mean "port"?',
    'extra: unknown key',
  ]);
  assert.deepEqual(messages(schema.decode([])), ['<root>: expected an object, got an array']);
});

test('decoded objects and arrays are frozen, and optional keys stay absent', () => {
  const schema = s.object({ name: s.string(), nickname: s.optional(s.string()), tags: s.array(s.string()) });
  const value = valueOf(schema.decode({ name: 'a', tags: ['x'] }));
  assert.deepEqual(value, { name: 'a', tags: ['x'] });
  assert.equal(Object.hasOwn(value, 'nickname'), false);
  assert.ok(Object.isFrozen(value) && Object.isFrozen(value.tags));
  assert.equal(valueOf(schema.decode({ name: 'a', nickname: 'b', tags: [] })).nickname, 'b');
});

test('objects can ignore keys they do not declare', () => {
  const schema = s.object({ name: s.string() }, { unknownKeys: 'ignore' });
  assert.deepEqual(valueOf(schema.decode({ name: 'a', other: 1 })), { name: 'a' });
});

test('keys whose names are not identifiers are quoted in paths', () => {
  const schema = s.record(s.object({ url: s.string() }));
  assert.deepEqual(messages(schema.decode({ 'read-only': {}, main: { url: 1 } })), [
    '["read-only"].url: missing required key',
    'main.url: expected a string, got 1',
  ]);
  assert.deepEqual(valueOf(schema.decode({ a: { url: 'u' } })), { a: { url: 'u' } });
});

test('unions take the first option that decodes and explain the closest failure', () => {
  const endpoint = s.union(s.string(), s.object({ host: s.string(), port: s.integer() }));
  assert.equal(valueOf(endpoint.decode('localhost:80')), 'localhost:80');
  assert.deepEqual(valueOf(endpoint.decode({ host: 'h', port: 1 })), { host: 'h', port: 1 });
  assert.deepEqual(messages(endpoint.decode({ host: 'h' })), ['port: missing required key']);
  assert.deepEqual(messages(endpoint.decode(1)), ['<root>: expected string | object, got 1']);
});

test('refine adds a check after decoding, and describe keeps the decoder', () => {
  const port = s.integer().refine(value => value > 0 && value < 65_536, 'expected a port from 1 to 65535').describe('Listening port');
  assert.equal(valueOf(port.decode(80)), 80);
  assert.deepEqual(messages(port.decode(0)), ['<root>: expected a port from 1 to 65535']);
  assert.deepEqual(messages(port.decode('80')), ['<root>: expected an integer, got "80"']);
  assert.equal(port.description, 'Listening port');
});

test('parse throws a ConfigError that lists every issue', () => {
  const schema = s.object({ a: s.integer(), b: s.integer() });
  assert.deepEqual(schema.parse({ a: 1, b: 2 }), { a: 1, b: 2 });
  assert.throws(() => schema.parse({ a: 'x' }), error => {
    assert.ok(error instanceof s.ConfigError);
    assert.equal(error.message, 'Invalid configuration:\n  a: expected an integer, got "x"\n  b: missing required key');
    assert.equal(error.issues.length, 2);
    return true;
  });
});

test('explain lists settings in order with labels, optionality, and descriptions', () => {
  const schema = s.object({
    server: s.object({ host: s.string().describe('Interface to bind'), port: s.of(s.Port) }),
    cache: s.optional(s.object({ size: s.of(s.ByteSize).describe('Upper bound') })),
    upstreams: s.record(s.object({ url: s.string() })),
    tags: s.array(s.string()),
    routes: s.array(s.object({ path: s.string() })),
  });
  assert.deepEqual(s.explain(schema).map(setting => [setting.path, setting.label, setting.optional]), [
    ['server.host', 'string', false],
    ['server.port', 'port', false],
    ['cache.size', 'byte size', true],
    ['upstreams.*.url', 'string', false],
    ['tags', 'string[]', false],
    ['routes[].path', 'string', false],
  ]);
  assert.equal(s.formatSettings(s.explain(schema)).split('\n')[0], 'server.host      string                Interface to bind');
  assert.equal(s.formatSettings(s.explain(schema)).split('\n')[2], 'cache.size       byte size (optional)  Upper bound');
});
