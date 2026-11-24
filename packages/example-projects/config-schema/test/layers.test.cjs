const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const s = require('../dist/index.js');
const { jsonFileLayer } = require('../dist/node.js');

const schema = s.object({
  server: s.object({ host: s.string(), port: s.of(s.Port), maxConnections: s.integer() }),
  debug: s.boolean(),
  level: s.oneOf('info', 'warn', 1),
  tags: s.array(s.string()),
  routes: s.array(s.object({ path: s.string(), timeout: s.optional(s.of(s.Duration)) })),
  upstreams: s.record(s.object({ url: s.string() })),
  extra: s.optional(s.unknown()),
});

const defaults = s.layer('defaults', {
  server: { host: 'localhost', port: 80, maxConnections: 10 },
  debug: false,
  level: 'info',
  tags: ['a', 'b'],
  routes: [],
  upstreams: {},
});

test('later layers override earlier ones key by key, and arrays as a whole', () => {
  const { values, origins } = s.mergeLayers([defaults, undefined, s.layer('config.json', { server: { port: 8080 }, tags: ['c'] })]);
  assert.deepEqual(values.server, { host: 'localhost', port: 8080, maxConnections: 10 });
  assert.deepEqual(values.tags, ['c']);
  assert.equal(origins.get('server.port'), 'config.json');
  assert.equal(origins.get('server.host'), 'defaults');
});

test('loadConfig names the layer of each rejected value but not of missing keys', () => {
  const loaded = s.loadConfig(schema, [
    defaults,
    s.layer('config.json', { server: { port: 'eighty', hots: 'x' }, level: 'loud' }),
    s.layer('override.json', { server: { maxConnections: undefined } }),
  ]);
  assert.deepEqual(loaded.issues.map(s.formatIssue), [
    'server.port: expected a port from 0 to 65535, got "eighty" (from config.json)',
    'server.hots: unknown key; did you mean "host"? (from config.json)',
    'level: expected one of "info", "warn", 1, got "loud" (from config.json)',
  ]);
  assert.deepEqual(s.loadConfig(schema, []).issues.map(s.formatIssue), ['<root>: expected an object, got nothing']);
  assert.throws(() => s.loadConfigOrThrow(schema, [s.layer('empty', {})]), s.ConfigError);
});

test('environment variables follow the schema to their keys and convert their text there', () => {
  const env = s.environmentLayer(schema, {
    APP_SERVER__PORT: '9000',
    APP_SERVER__MAX_CONNECTIONS: '20',
    APP_DEBUG: 'TRUE',
    APP_LEVEL: '1',
    APP_TAGS: '["x", "y"]',
    APP_ROUTES__0__PATH: '/',
    APP_ROUTES__0__TIMEOUT: '5s',
    APP_UPSTREAMS__MAIN_DB__URL: 'postgres://db',
    APP_EXTRA: '{"any": [1]}',
    OTHER_VARIABLE: 'ignored',
    APP_: 'ignored',
  }, { prefix: 'APP_' });
  const config = s.loadConfigOrThrow(schema, [defaults, env]);
  assert.equal(config.server.port.number, 9000);
  assert.equal(config.server.maxConnections, 20);
  assert.equal(config.debug, true);
  assert.equal(config.level, 1);
  assert.deepEqual(config.tags, ['x', 'y']);
  assert.equal(config.routes[0].path, '/');
  assert.equal(config.routes[0].timeout.milliseconds, 5_000);
  assert.deepEqual(config.upstreams, { mainDb: { url: 'postgres://db' } });
  assert.deepEqual(config.extra, { any: [1] });
  assert.equal(env.origins.get('server.maxConnections'), 'APP_SERVER__MAX_CONNECTIONS');
});

test('environment variables keep text the schema rejects and report the variable', () => {
  const env = s.environmentLayer(schema, {
    APP_SERVER__MAX_CONNECTIONS: 'many',
    APP_DEBUG: 'maybe',
    APP_SERVER__PROT: '1',
    APP_TAGS: 'not json',
  }, { prefix: 'APP_', name: 'shell' });
  assert.deepEqual(s.loadConfig(schema, [defaults, env]).issues.map(s.formatIssue), [
    'server.maxConnections: expected an integer, got "many" (from APP_SERVER__MAX_CONNECTIONS)',
    'server.prot: unknown key; did you mean "port"? (from APP_SERVER__PROT)',
    'debug: expected true or false, got "maybe" (from APP_DEBUG)',
    'tags: expected an array, got "not json" (from APP_TAGS)',
  ]);
  assert.throws(() => s.environmentLayer(schema, {}, { prefix: '' }), /nonempty prefix/u);
});

test('a custom separator splits nested keys', () => {
  const env = s.environmentLayer(schema, { 'APP.SERVER.HOST': 'example.com' }, { prefix: 'APP.', separator: '.' });
  assert.deepEqual(env.values, { server: { host: 'example.com' } });
});

test('JSON files become layers, and only a missing optional file is skipped', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'config-schema-'));
  try {
    const valid = path.join(directory, 'config.json');
    fs.writeFileSync(valid, '﻿{"debug": true}');
    assert.deepEqual(jsonFileLayer(valid), { name: valid, values: { debug: true } });

    const missing = path.join(directory, 'missing.json');
    assert.equal(jsonFileLayer(missing, { optional: true }), undefined);
    assert.throws(() => jsonFileLayer(missing), error => error instanceof s.ConfigError && error.issues[0].source === missing
      && /cannot read the file/u.test(error.issues[0].message));

    const malformed = path.join(directory, 'malformed.json');
    fs.writeFileSync(malformed, '{debug: true}');
    assert.throws(() => jsonFileLayer(malformed, { optional: true }), /the file is not valid JSON/u);
  }
  finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
