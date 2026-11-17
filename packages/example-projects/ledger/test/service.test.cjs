const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const { createLedgerServer } = require('../dist/server.js');
const { fileStorage, memoryStorage, readStored, writeStored } = require('../dist/store.js');
const { emptyLedger, addAccount } = require('../dist/domain.js');
const { exportCsv } = require('../dist/csv.js');

const tempDirs = [];
function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tspp-ledger-'));
  tempDirs.push(dir);
  return path.join(dir, 'ledger.json');
}
test.after(() => {
  const prefix = path.join(os.tmpdir(), 'tspp-ledger-');
  for (const dir of tempDirs) {
    if (!dir.startsWith(prefix) || path.dirname(dir) !== os.tmpdir()) throw new Error('Invalid temporary directory');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
async function start(filePath) {
  const app = await createLedgerServer({ filePath, port: 0 });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (route, value, type = 'application/json') => fetch(base + route, { method: 'POST', headers: { origin: base, 'content-type': type }, body: type === 'application/json' ? JSON.stringify(value) : value });
  return { ...app, base, post };
}
test('storage effect works with memory and validates persisted state', () => {
  const store = memoryStorage();
  const next = addAccount(readStored(store), { name: 'Cash', openingBalance: '12.34' }, 'a');
  writeStored(store, next);
  assert.deepEqual(readStored(store), next);
  store.close();
  const file = tempFile();
  const disk = fileStorage(file);
  writeStored(disk, next);
  assert.throws(() => fileStorage(file));
  disk.close();
  const reopened = fileStorage(file);
  assert.deepEqual(readStored(reopened), next);
  reopened.close();
  fs.writeFileSync(file, '{broken');
  const broken = fileStorage(file);
  assert.throws(() => readStored(broken));
  broken.close();
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('service persists, exports and imports atomically', async () => {
  const file = tempFile();
  const app = await start(file);
  try {
    let response = await app.post('/api/accounts', { name: 'Cash', openingBalance: '10.00' });
    assert.equal(response.status, 200);
    let summary = await response.json();
    const id = summary.accounts[0].id;
    response = await app.post('/api/transactions', { kind: 'expense', accountId: id, amount: '1.25', note: 'tea, "hot"\nnow', date: '2026-01-01' });
    assert.equal(response.status, 200);
    summary = await response.json();
    const csv = await (await fetch(app.base + '/api/export.csv')).text();
    response = await app.post('/api/import.csv', csv, 'text/csv');
    assert.equal(response.status, 400);
    assert.deepEqual(await (await fetch(app.base + '/api/ledger')).json(), summary);
    response = await app.post('/api/split', { amount: '1.00', count: 3 });
    assert.deepEqual((await response.json()).shares, ['34', '33', '33']);
    const other = await start(tempFile());
    try {
      response = await other.post('/api/import.csv', csv, 'text/csv');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), summary);
    } finally { await other.close(); }
  } finally { await app.close(); }
  const reopened = await start(file);
  try { assert.equal((await (await fetch(reopened.base + '/api/ledger')).json()).accounts.length, 1); }
  finally { await reopened.close(); }
});
test('service rejects hostile origins, hosts, content types and oversized bodies', async () => {
  const app = await start(tempFile());
  try {
    let response = await fetch(app.base + '/api/accounts', { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
    response = await fetch(app.base + '/api/accounts', { method: 'POST', headers: { origin: app.base, 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(response.status, 415);
    response = await fetch(app.base + '/api/accounts', { method: 'POST', headers: { origin: app.base, 'content-type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(response.status, 413);
    const hostStatus = await new Promise((resolve, reject) => {
      const request = http.get(app.base + '/api/ledger', { headers: { host: 'evil.example' } }, result => {
        result.resume();
        result.on('end', () => resolve(result.statusCode));
      });
      request.on('error', reject);
    });
    assert.equal(hostStatus, 403);
  } finally { await app.close(); }
});
test('failed save leaves in-memory state unchanged', async () => {
  const file = tempFile();
  const app = await start(file);
  try {
    fs.mkdirSync(file);
    const response = await app.post('/api/accounts', { name: 'Cash', openingBalance: '0' });
    assert.equal(response.status, 500);
    assert.equal((await (await fetch(app.base + '/api/ledger')).json()).accounts.length, 0);
    fs.rmdirSync(file);
    const retry = await app.post('/api/accounts', { name: 'Cash', openingBalance: '0' });
    assert.equal(retry.status, 200);
  } finally { await app.close(); }
});
test('concurrent requests do not lose writes', async () => {
  const app = await start(tempFile());
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, (_, i) => app.post('/api/accounts', { name: `Account ${i}`, openingBalance: '0' })));
    assert.ok(responses.every(response => response.status === 200));
    assert.equal((await (await fetch(app.base + '/api/ledger')).json()).accounts.length, 8);
  } finally { await app.close(); }
});

test('a late invalid CSV record leaves both persisted and live data untouched', async () => {
  const file = tempFile();
  const app = await start(file);
  try {
    const initial = await (await app.post('/api/accounts', { name: 'Existing', openingBalance: '5' })).json();
    const original = fs.readFileSync(file, 'utf8');
    const incoming = addAccount(emptyLedger(), { name: 'Incoming', openingBalance: '2' }, 'incoming');
    const csv = exportCsv(incoming) + 'transaction,bad,,,expense,missing,,100,note,2026-11-17,false\r\n';
    assert.equal((await app.post('/api/import.csv', csv, 'text/csv')).status, 400);
    assert.deepEqual(await (await fetch(app.base + '/api/ledger')).json(), initial);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  } finally { await app.close(); }
});

test('transfer and void endpoints preserve totals and reject extraneous payload fields', async () => {
  const app = await start(tempFile());
  try {
    const first = await (await app.post('/api/accounts', { name: 'Cash', openingBalance: '100' })).json();
    const second = await (await app.post('/api/accounts', { name: 'Bank', openingBalance: '-2' })).json();
    const response = await app.post('/api/transactions', { kind: 'transfer', accountId: first.accounts[0].id, toAccountId: second.accounts[1].id, amount: '33.34', date: '2026-11-17' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, '9800');
    assert.equal(result.income, '0');
    assert.equal(result.expense, '0');
    assert.deepEqual(result.accounts.map(item => item.balance), ['6666', '3134']);
    const route = `/api/transactions/${result.transactions[0].id}/void`;
    assert.equal((await app.post(route, { unexpected: true })).status, 400);
    const voided = await (await app.post(route, {})).json();
    assert.deepEqual(voided.accounts.map(item => item.balance), ['10000', '-200']);
    assert.equal(voided.transactions[0].voided, true);
    assert.equal((await app.post('/api/split', { amount: '1', count: 3, extra: 0 })).status, 400);
  } finally { await app.close(); }
});

test('CLI help and argument errors finish without creating a ledger', () => {
  const cli = path.join(__dirname, '../dist/cli.js');
  const file = tempFile();
  const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
  const help = run(['--data', file, '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--port/);
  assert.equal(fs.existsSync(file), false);
  for (const args of [['--unknown'], ['--port', 'abc'], ['--port', '65536'], ['--data', '']]) {
    const invalid = run(args);
    assert.notEqual(invalid.status, 0, invalid.stdout + invalid.stderr);
    assert.equal(invalid.error, undefined);
  }
});

test('the local UI serves only its declared assets and supplies browser protections', async () => {
  const app = await start(tempFile());
  try {
    for (const [route, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/style.css', 'text/css']]) {
      const response = await fetch(app.base + route);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), new RegExp(type));
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.ok((await response.text()).length > 0);
    }
    assert.equal((await fetch(app.base + '/domain.js')).status, 404);
    assert.equal((await fetch(app.base + '/api/ledger.json')).status, 404);
    assert.equal((await fetch(app.base + '/api/accounts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  } finally { await app.close(); }
});
