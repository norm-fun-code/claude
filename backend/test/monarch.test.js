const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../src/connectors/monarch');

test('parseAmount handles $, commas, and parentheses-negatives', () => {
  assert.equal(m.parseAmount('$1,234.56'), 1234.56);
  assert.equal(m.parseAmount('-42.10'), -42.1);
  assert.equal(m.parseAmount('(89.00)'), -89);
  assert.ok(Number.isNaN(m.parseAmount('')));
});

test('parseDay normalizes ISO and US dates', () => {
  assert.equal(m.parseDay('2026-05-30'), '2026-05-30');
  assert.equal(m.parseDay('5/3/2026'), '2026-05-03');
  assert.equal(m.parseDay('garbage'), null);
});

test('detectKind classifies transaction and balance headers', () => {
  assert.equal(m.detectKind(['Date', 'Merchant', 'Category', 'Account', 'Amount', 'Tags']), 'transactions');
  assert.equal(m.detectKind(['Date', 'Net Worth']), 'balances');
  assert.equal(m.detectKind(['Date', 'Account', 'Balance']), 'balances');
  assert.equal(m.detectKind(['foo', 'bar']), 'unknown');
});

test('mapTransactions aggregates spending/income per day and emits documents', () => {
  const records = [
    { Date: '2026-05-01', Merchant: 'Whole Foods', Category: 'Groceries', Account: 'Amex', Amount: '-50.00' },
    { Date: '2026-05-01', Merchant: 'Coffee', Category: 'Dining', Account: 'Amex', Amount: '-5.00' },
    { Date: '2026-05-01', Merchant: 'Paycheck', Category: 'Income', Account: 'Checking', Amount: '2000.00' },
    { Date: '2026-05-02', Merchant: 'Gas', Category: 'Auto', Account: 'Visa', Amount: '-40.00' },
  ];
  const { metrics, documents } = m.mapTransactions(records);

  // One document per transaction.
  assert.equal(documents.length, 4);

  const get = (metric, day) =>
    metrics.find((x) => x.metric === metric && x.ts.toISOString().startsWith(day))?.value;

  assert.equal(get('spending', '2026-05-01'), 55); // 50 + 5 aggregated
  assert.equal(get('income', '2026-05-01'), 2000);
  assert.equal(get('net_cashflow', '2026-05-01'), 1945);
  assert.equal(get('spending', '2026-05-02'), 40);
  assert.equal(get('net_cashflow', '2026-05-02'), -40);

  // No duplicate (ts, metric) keys — the bulk insert would reject those.
  const keys = metrics.map((x) => `${x.ts.toISOString()}|${x.metric}`);
  assert.equal(new Set(keys).size, keys.length);

  // All wealth/usd/monarch.
  for (const row of metrics) {
    assert.equal(row.domain, 'wealth');
    assert.equal(row.source, 'monarch');
    assert.equal(row.unit, 'usd');
  }
});

test('transaction document ids are stable across re-import', () => {
  const rec = [{ Date: '2026-05-01', Merchant: 'X', Category: 'Y', Account: 'Z', Amount: '-1.00' }];
  const a = m.mapTransactions(rec).documents[0].externalId;
  const b = m.mapTransactions(rec).documents[0].externalId;
  assert.equal(a, b);
});

test('mapBalances uses a Net Worth column when present', () => {
  const { metrics } = m.mapBalances([{ Date: '2026-05-31', 'Net Worth': '$250,000' }]);
  const nw = metrics.find((x) => x.metric === 'net_worth');
  assert.equal(nw.value, 250000);
  assert.ok(nw.ts.toISOString().startsWith('2026-05-31'));
});

test('mapBalances classifies assets/liabilities from per-account rows with types', () => {
  const { metrics } = m.mapBalances([
    { Date: '2026-05-31', Account: 'Brokerage', Type: 'investment', Balance: '100000' },
    { Date: '2026-05-31', Account: 'Checking', Type: 'depository', Balance: '20000' },
    { Date: '2026-05-31', Account: 'Visa', Type: 'credit', Balance: '5000' },
  ]);
  const v = (metric) => metrics.find((x) => x.metric === metric)?.value;
  assert.equal(v('assets'), 120000);
  assert.equal(v('liabilities'), 5000);
  assert.equal(v('net_worth'), 115000);
});

test('dedupeMetrics sums flows and keeps last snapshot', () => {
  const ts = new Date('2026-05-01T00:00:00Z');
  const out = m.dedupeMetrics([
    { ts, domain: 'wealth', metric: 'spending', value: 10, unit: 'usd', source: 'monarch' },
    { ts, domain: 'wealth', metric: 'spending', value: 5, unit: 'usd', source: 'monarch' },
    { ts, domain: 'wealth', metric: 'net_worth', value: 100, unit: 'usd', source: 'monarch' },
    { ts, domain: 'wealth', metric: 'net_worth', value: 200, unit: 'usd', source: 'monarch' },
  ]);
  assert.equal(out.find((x) => x.metric === 'spending').value, 15);
  assert.equal(out.find((x) => x.metric === 'net_worth').value, 200);
});
