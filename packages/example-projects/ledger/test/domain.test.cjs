const test = require('node:test');
const assert = require('node:assert/strict');
const { emptyLedger, validateLedger, addAccount, addTransaction, voidTransaction, summarize } = require('../dist/domain.js');
const { parseMoney, formatMoney, splitMoney } = require('../dist/money.js');

function accounts() {
  let state = addAccount(emptyLedger(), { name: '现金', openingBalance: '100.00' }, 'cash');
  return addAccount(state, { name: '银行卡', openingBalance: '-5.50' }, 'bank');
}
function transaction(overrides = {}) {
  return { kind: 'expense', accountId: 'cash', amount: '0.01', note: '早餐', date: '2024-02-29', ...overrides };
}

test('decimal money stays exact above Number precision and formats negative cents', () => {
  assert.equal(parseMoney('9007199254740993.11'), 900719925474099311n);
  assert.equal(parseMoney('0.1') + parseMoney('0.2'), 30n);
  assert.equal(parseMoney('-0.01'), -1n);
  assert.equal(parseMoney('-0.00'), 0n);
  assert.equal(formatMoney(-1n), '-0.01');
  assert.equal(formatMoney(0n), '0.00');
  assert.equal(formatMoney(12345n), '123.45');
  for (const value of ['1.001', 'NaN', 'Infinity', '1e2', '+1', ' 1', '1 ', '.1', '01', '', '1.', 1, null]) {
    assert.throws(() => parseMoney(value));
  }
});

test('equal split preserves every cent and assigns remainder in stable order', () => {
  assert.deepEqual(splitMoney(100n, 3n), [34n, 33n, 33n]);
  assert.deepEqual(splitMoney(2n, 4n), [1n, 1n, 0n, 0n]);
  assert.deepEqual(splitMoney(0n, 3n), [0n, 0n, 0n]);
  for (const total of [1n, 100n, 900719925474099311n]) {
    for (const count of [1n, 3n, 7n, 1000n]) {
      const shares = splitMoney(total, count);
      assert.equal(shares.length, Number(count));
      assert.equal(shares.reduce((sum, item) => sum + item, 0n), total);
      assert.ok(shares.every(item => item === total / count || item === total / count + 1n));
      assert.ok(shares[0] - shares.at(-1) <= 1n);
    }
  }
  for (const [total, count] of [[-1n, 2n], [1n, 0n], [1n, -1n], [1n, 1001n], [1, 2n]]) {
    assert.throws(() => splitMoney(total, count));
  }
});

test('decimal input and persisted cents share the same explicit 100 digit limit', () => {
  const cents = 10n ** 100n - 1n;
  for (const amount of [cents, -cents]) {
    const decimal = formatMoney(amount);
    assert.equal(parseMoney(decimal), amount);
    const state = addAccount(emptyLedger(), { name: '大额', openingBalance: decimal }, 'large');
    assert.equal(validateLedger(state).accounts[0].openingBalance, amount.toString());
    assert.equal(summarize(state).total, amount.toString());
  }
  assert.throws(() => parseMoney(formatMoney(10n ** 100n)));
  assert.throws(() => validateLedger({ version: 1, transactions: [], accounts: [
    { id: 'large', name: '超限', openingBalance: (10n ** 100n).toString() },
  ] }));
});

test('income, expense, overdraft and transfer produce exact balances without mutating inputs', () => {
  const initial = accounts();
  const original = JSON.stringify(initial);
  let state = addTransaction(initial, transaction({ kind: 'income', amount: '0.10' }), 'income');
  state = addTransaction(state, transaction({ amount: '150.20' }), 'expense');
  const beforeTransfer = summarize(state);
  state = addTransaction(state, transaction({ kind: 'transfer', toAccountId: 'bank', amount: '12.34' }), 'transfer');
  const summary = summarize(state);
  assert.equal(summary.total, beforeTransfer.total);
  assert.equal(summary.total, '-5560');
  assert.equal(summary.income, '10');
  assert.equal(summary.expense, '15020');
  assert.deepEqual(summary.accounts.map(item => item.balance), ['-6244', '684']);
  assert.equal(JSON.stringify(initial), original);
});

test('void reverses a complete transfer and keeps an auditable original entry', () => {
  const initial = accounts();
  const transferred = addTransaction(initial, transaction({ kind: 'transfer', toAccountId: 'bank', amount: '12.34' }), 'transfer');
  const voided = voidTransaction(transferred, 'transfer');
  assert.deepEqual(summarize(voided).accounts, summarize(initial).accounts);
  assert.equal(voided.transactions.length, 1);
  assert.equal(voided.transactions[0].amount, '1234');
  assert.equal(voided.transactions[0].voided, true);
  assert.equal(transferred.transactions[0].voided, false);
  assert.throws(() => voidTransaction(voided, 'transfer'), /已经作废/);
  assert.throws(() => voidTransaction(voided, 'missing'), /不存在/);
});

test('voiding income and expense removes their reported totals', () => {
  let state = addTransaction(accounts(), transaction({ kind: 'income', amount: '10' }), 'income');
  state = addTransaction(state, transaction({ amount: '3' }), 'expense');
  state = voidTransaction(voidTransaction(state, 'income'), 'expense');
  assert.equal(summarize(state).income, '0');
  assert.equal(summarize(state).expense, '0');
  assert.equal(summarize(state).total, '9450');
});

test('invalid account payloads fail before changing the state', () => {
  const initial = accounts();
  for (const input of [null, [], {}, { name: '', openingBalance: '0' }, { name: 'x', openingBalance: 1 },
    { name: 'x', openingBalance: '1.001' }, { name: 'x', openingBalance: '0', currency: 'USD' }]) {
    assert.throws(() => addAccount(initial, input, 'new'));
  }
  assert.throws(() => addAccount(initial, { name: '重复', openingBalance: '0' }, 'cash'), /重复/);
  assert.throws(() => addAccount(initial, { name: '错误', openingBalance: '0' }, '../bad'));
  assert.equal(initial.accounts.length, 2);
});

test('transaction boundary rejects wrong types, references, dates, amounts and extraneous fields', () => {
  const initial = accounts();
  for (const patch of [
    { amount: '0' }, { amount: '-1' }, { amount: 1 }, { amount: '1.001' },
    { kind: 'refund' }, { accountId: 'missing' }, { note: null }, { voided: true },
    { date: '2023-02-29' }, { date: '1900-02-29' }, { date: '2024-04-31' },
    { date: '0000-01-01' }, { date: '2024-00-01' }, { date: '2024-1-01' },
    { toAccountId: 'bank' }, { kind: 'transfer' },
    { kind: 'transfer', toAccountId: 'cash' }, { kind: 'transfer', toAccountId: 'missing' },
  ]) assert.throws(() => addTransaction(initial, transaction(patch), 'new'), JSON.stringify(patch));
  const state = addTransaction(initial, transaction({ date: '2000-02-29' }), 'valid');
  assert.throws(() => addTransaction(state, transaction(), 'valid'), /重复/);
  assert.equal(initial.transactions.length, 0);
});

test('persisted validation rejects corrupt cents, duplicate ids and broken references even on void entries', () => {
  const valid = addTransaction(accounts(), transaction(), 'one');
  const clone = () => JSON.parse(JSON.stringify(valid));
  const invalid = [];
  let state = clone(); state.accounts.push({ ...state.accounts[0] }); invalid.push(state);
  state = clone(); state.transactions.push({ ...state.transactions[0] }); invalid.push(state);
  for (const amount of ['01', '-0', '1.0', '1e2', 1]) {
    state = clone(); state.accounts[0].openingBalance = amount; invalid.push(state);
  }
  for (const patch of [{ amount: '-1' }, { amount: '0' }, { voided: 'false' }, { accountId: 'missing', voided: true },
    { kind: 'transfer', toAccountId: 'cash' }, { toAccountId: 'bank' }, { extra: 1 }]) {
    state = clone(); Object.assign(state.transactions[0], patch); invalid.push(state);
  }
  invalid.push({ ...clone(), version: 2 }, { ...clone(), currency: 'USD' }, { ...clone(), accounts: null });
  for (const input of invalid) assert.throws(() => validateLedger(input));
  const result = validateLedger(valid);
  assert.deepEqual(result, valid);
  result.accounts[0].name = 'changed';
  assert.equal(valid.accounts[0].name, '现金');
});

test('empty ledger and omitted notes have stable JSON shapes', () => {
  assert.deepEqual(summarize(emptyLedger()), { version: 1, accounts: [], transactions: [], total: '0', income: '0', expense: '0' });
  const input = transaction(); delete input.note;
  assert.equal(addTransaction(accounts(), input, 'note').transactions[0].note, '');
});
