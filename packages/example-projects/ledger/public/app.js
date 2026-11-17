'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const state = { summary: null, voidId: null, busy: false };
const labels = { income: '收入', expense: '支出', transfer: '转账' };

function money(cents) {
  const n = BigInt(cents);
  const sign = n < 0n ? '-' : '';
  const digits = (n < 0n ? -n : n).toString().padStart(3, '0');
  return `${sign}¥ ${digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${digits.slice(-2)}`;
}

function node(tag, className, content) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (content !== undefined) el.textContent = content;
  return el;
}

function notice(message, error = false) {
  const el = $('#notice');
  el.textContent = message;
  el.className = error ? 'show error' : 'show';
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { el.className = ''; }, 5000);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('服务器返回了无法读取的结果');
  }
  if (!response.ok) throw new Error(data.error || '操作失败，请重试');
  return data;
}

async function action(work, success, onError) {
  if (state.busy) return;
  state.busy = true;
  document.body.classList.add('busy');
  document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = true; });
  const activeForm = $('dialog[open] form');
  const formError = activeForm && $('.form-error', activeForm);
  if (formError) formError.hidden = true;
  try {
    const result = await work();
    if (success) success(result);
  } catch (error) {
    const message = error.message || '操作失败，请重试';
    if (onError) onError(message);
    else if (formError) {
      formError.textContent = message;
      formError.hidden = false;
    } else notice(message, true);
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
    document.querySelectorAll('button[type="submit"]').forEach(button => { button.disabled = false; });
  }
}

function jsonPost(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function update(summary) {
  state.summary = summary;
  $('#total').textContent = money(summary.total);
  $('#income').textContent = money(summary.income);
  $('#expense').textContent = money(summary.expense);
  renderAccounts();
  renderTransactions();
}

function option(value, title) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = title;
  return el;
}

function renderAccounts() {
  const accounts = state.summary.accounts;
  const list = $('#account-list');
  list.replaceChildren();
  $('#empty-accounts').hidden = accounts.length > 0;
  accounts.forEach((account, index) => {
    const row = node('div', 'account-row');
    row.append(node('span', 'account-avatar', account.name.trim().slice(0, 1) || '账'));
    const details = node('div', 'account-details');
    details.append(node('strong', '', account.name), node('small', '', `账户 ${String(index + 1).padStart(2, '0')}`));
    row.append(details, node('strong', 'account-balance', money(account.balance)));
    list.append(row);
  });
  const filter = $('#filter-account');
  const previous = filter.value;
  filter.replaceChildren(option('', '全部账户'));
  accounts.forEach(account => filter.append(option(account.id, account.name)));
  filter.value = accounts.some(account => account.id === previous) ? previous : '';
  const form = $('#transaction-form');
  for (const name of ['accountId', 'toAccountId']) {
    const select = form.elements[name];
    const old = select.value;
    select.replaceChildren(option('', '请选择账户'));
    accounts.forEach(account => select.append(option(account.id, account.name)));
    if (accounts.some(account => account.id === old)) select.value = old;
  }
}

function renderTransactions() {
  if (!state.summary) return;
  const accounts = new Map(state.summary.accounts.map(account => [account.id, account.name]));
  const query = $('#search').value.trim().toLocaleLowerCase();
  const account = $('#filter-account').value;
  const kind = $('#filter-kind').value;
  const rows = state.summary.transactions.map((transaction, index) => ({ transaction, index }))
    .filter(({ transaction: t }) => (!account || t.accountId === account || t.toAccountId === account)
      && (!kind || t.kind === kind)
      && (!query || [t.note, accounts.get(t.accountId), accounts.get(t.toAccountId)]
        .some(value => (value || '').toLocaleLowerCase().includes(query))))
    .sort((a, b) => b.transaction.date.localeCompare(a.transaction.date) || b.index - a.index);
  $('#transaction-count').textContent = String(rows.length);
  const body = $('#transaction-list');
  body.replaceChildren();
  $('#empty-transactions').hidden = rows.length > 0;
  rows.forEach(({ transaction: t }) => {
    const tr = node('tr', t.voided ? 'voided' : '');
    const name = node('td');
    const title = node('div', 'transaction-title');
    title.append(node('span', `transaction-icon ${t.kind}`, t.kind === 'income' ? '↙' : t.kind === 'expense' ? '↗' : '⇄'));
    const text = node('span');
    text.append(node('strong', '', t.note || labels[t.kind] || t.kind));
    const sub = node('small', '', labels[t.kind] || t.kind);
    if (t.voided) sub.append(node('span', 'void-badge', '已作废'));
    text.append(sub);
    title.append(text);
    name.append(title);
    const accountName = accounts.get(t.accountId) || '未知账户';
    const destination = t.kind === 'transfer' ? ` → ${accounts.get(t.toAccountId) || '未知账户'}` : '';
    const amount = `${t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : ''}${money(t.amount)}`;
    tr.append(name, node('td', 'account-cell', accountName + destination), node('td', 'date-cell', t.date), node('td', `amount align-right ${t.kind}`, amount));
    const actions = node('td', 'row-action');
    if (!t.voided) {
      const button = node('button', 'void-button', '作废');
      button.type = 'button';
      button.setAttribute('aria-label', `作废${t.note || labels[t.kind]}记录`);
      button.addEventListener('click', () => {
        state.voidId = t.id;
        openDialog($('#void-dialog'));
      });
      actions.append(button);
    }
    tr.append(actions);
    body.append(tr);
  });
}

function openDialog(dialog) {
  const error = $('.form-error', dialog);
  if (error) error.hidden = true;
  if (!dialog.open) dialog.showModal();
}

function closeDialog(dialog) { dialog.close(); }

document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => closeDialog(button.closest('dialog')));
});
$('#add-account').addEventListener('click', () => openDialog($('#account-dialog')));
$('#empty-add-account').addEventListener('click', () => openDialog($('#account-dialog')));
$('#add-transaction').addEventListener('click', () => {
  if (!state.summary) { notice('请先加载账本', true); return; }
  if (!state.summary.accounts.length) {
    notice('请先创建账户');
    openDialog($('#account-dialog'));
    return;
  }
  const form = $('#transaction-form');
  const now = new Date();
  form.elements.date.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (!form.elements.accountId.value) form.elements.accountId.value = state.summary.accounts[0].id;
  openDialog($('#transaction-dialog'));
});
$('#open-split').addEventListener('click', () => openDialog($('#split-dialog')));
$('#transaction-form').elements.kind.addEventListener('change', event => {
  const transfer = event.target.value === 'transfer';
  $('#destination-label').hidden = !transfer;
  $('#transaction-form').elements.toAccountId.required = transfer;
});
$('#account-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  action(() => request('/api/accounts', jsonPost({ name: form.elements.name.value.trim(), openingBalance: form.elements.openingBalance.value.trim() })), result => {
    update(result);
    form.reset();
    closeDialog($('#account-dialog'));
    notice('账户已创建');
  });
});
$('#transaction-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = { kind: form.elements.kind.value, accountId: form.elements.accountId.value, amount: form.elements.amount.value.trim(), note: form.elements.note.value.trim(), date: form.elements.date.value };
  if (data.kind === 'transfer') data.toAccountId = form.elements.toAccountId.value;
  action(() => request('/api/transactions', jsonPost(data)), result => {
    update(result);
    form.reset();
    $('#destination-label').hidden = true;
    form.elements.toAccountId.required = false;
    closeDialog($('#transaction-dialog'));
    notice('记录已保存');
  });
});
$('#void-form').addEventListener('submit', event => {
  event.preventDefault();
  action(() => request(`/api/transactions/${encodeURIComponent(state.voidId)}/void`, jsonPost({})), result => {
    update(result);
    closeDialog($('#void-dialog'));
    notice('记录已作废');
  });
});
$('#split-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const count = Number(form.elements.count.value);
  if (!Number.isSafeInteger(count) || count < 1 || count > 1000) {
    const error = $('.form-error', form);
    error.textContent = '人数须为 1 到 1000 的整数';
    error.hidden = false;
    return;
  }
  action(() => request('/api/split', jsonPost({ amount: form.elements.amount.value.trim(), count })), result => {
    const output = $('#split-result');
    const total = result.shares.reduce((sum, share) => sum + BigInt(share), 0n);
    output.replaceChildren(node('strong', '', `分摊结果 · 合计 ${money(total)}`), node('p', 'split-explanation', '无法均分的零头按顺序分配，每人最多相差一分钱。'));
    result.shares.forEach((share, index) => {
      const row = node('div', 'split-row');
      row.append(node('span', '', `第 ${index + 1} 人`), node('strong', '', money(share)));
      output.append(row);
    });
  });
});
$('#import-file').addEventListener('change', event => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  input.value = '';
  if (file.size > 1024 * 1024) { notice('CSV 文件不能超过 1 MiB', true); return; }
  action(async () => request('/api/import.csv', { method: 'POST', headers: { 'Content-Type': 'text/csv' }, body: await file.text() }), result => {
    update(result);
    notice('CSV 导入成功');
  });
});
['search', 'filter-account', 'filter-kind'].forEach(id => $(`#${id}`).addEventListener('input', renderTransactions));
$('#clear-filters').addEventListener('click', () => {
  $('#search').value = '';
  $('#filter-account').value = '';
  $('#filter-kind').value = '';
  renderTransactions();
});
document.querySelectorAll('.nav-link').forEach(link => link.addEventListener('click', () => {
  document.querySelectorAll('.nav-link').forEach(item => item.classList.remove('active'));
  link.classList.add('active');
}));
function loadLedger() {
  $('#retry-load').disabled = true;
  action(() => request('/api/ledger'), result => {
    update(result);
    $('#load-error').hidden = true;
  }, message => {
    $('#load-error span').textContent = `账本加载失败：${message}`;
    $('#load-error').hidden = false;
  }).finally(() => { $('#retry-load').disabled = false; });
}
$('#retry-load').addEventListener('click', loadLedger);
loadLedger();
