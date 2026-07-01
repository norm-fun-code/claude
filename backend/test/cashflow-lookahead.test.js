const test = require('node:test');
const assert = require('node:assert/strict');
const { computeCashflowLookahead } = require('../src/intelligence/cashflow-lookahead');

const ASOF = new Date('2026-06-10T12:00:00Z');
const inDays = (n) => new Date(ASOF.getTime() + n * 864e5).toISOString();
const cashAccount = (balance) => ({ name: 'Checking', type: 'checking', subtype: '', balance, isAsset: true });

test('no upcoming streams within the window → not thin, no detail', () => {
  const r = computeCashflowLookahead({ streams: [], accounts: [cashAccount(2000)], asOf: ASOF });
  assert.equal(r.thin, false);
  assert.equal(r.detail, null);
  assert.deepEqual(r.upcoming, []);
});

test('a bill outside the lookahead window is excluded', () => {
  const streams = [{ name: 'Rent', amount: 2000, nextDate: inDays(10) }];
  const r = computeCashflowLookahead({ streams, accounts: [cashAccount(2000)], days: 4, asOf: ASOF });
  assert.equal(r.upcoming.length, 0);
  assert.equal(r.thin, false);
});

test('ample buffer against an upcoming bill is not flagged', () => {
  const streams = [{ name: 'Netflix', amount: 20, nextDate: inDays(2) }];
  const r = computeCashflowLookahead({ streams, accounts: [cashAccount(5000)], days: 4, asOf: ASOF });
  assert.equal(r.upcoming.length, 1);
  assert.equal(r.thin, false);
  assert.equal(r.detail, null);
});

test('a bill eating a large share of the buffer is flagged (ratio trigger)', () => {
  const streams = [{ name: 'Rent', amount: 2200, nextDate: inDays(1) }];
  const r = computeCashflowLookahead({ streams, accounts: [cashAccount(3000)], days: 4, thinRatio: 0.35, asOf: ASOF });
  assert.equal(r.thin, true);
  assert.match(r.detail, /Rent/);
  assert.match(r.detail, /tomorrow/);
  assert.match(r.detail, /\$2,?200|2200/);
});

test('a small bill still trips the absolute floor when the buffer is nearly wiped out', () => {
  const streams = [{ name: 'Utilities', amount: 150, nextDate: inDays(0) }];
  const r = computeCashflowLookahead({ streams, accounts: [cashAccount(200)], thinRatio: 0.9, thinFloor: 500, asOf: ASOF });
  assert.equal(r.thin, true, 'buffer minus the bill (50) is under the 500 floor');
  assert.match(r.detail, /today/);
});

test('multiple upcoming bills sum into totalUpcoming and list up to 3 by date', () => {
  const streams = [
    { name: 'Rent', amount: 2000, nextDate: inDays(3) },
    { name: 'Car', amount: 400, nextDate: inDays(1) },
    { name: 'Gym', amount: 60, nextDate: inDays(2) },
    { name: 'Storage', amount: 80, nextDate: inDays(3) },
  ];
  const r = computeCashflowLookahead({ streams, accounts: [cashAccount(2000)], days: 4, asOf: ASOF });
  assert.equal(r.totalUpcoming, 2540);
  assert.equal(r.upcoming[0].name, 'Car'); // soonest first
  assert.equal(r.thin, true);
  // 3 named bills (capped) + the total-upcoming figure + the buffer figure = 5 max.
  const mentioned = (r.detail.match(/\$/g) || []).length;
  assert.ok(mentioned <= 5, 'detail names at most 3 bills plus the total and buffer figures');
  assert.ok(!r.detail.includes('Storage'), 'only the 3 soonest bills are named');
});

test('no account data → cashBuffer null, never flagged as thin regardless of bill size', () => {
  const streams = [{ name: 'Rent', amount: 5000, nextDate: inDays(1) }];
  const r = computeCashflowLookahead({ streams, accounts: [], asOf: ASOF });
  assert.equal(r.cashBuffer, null);
  assert.equal(r.thin, false);
  assert.equal(r.detail, null);
});

test('a bill with no nextDate or zero amount is ignored', () => {
  const streams = [{ name: 'Weird', amount: 0, nextDate: inDays(1) }, { name: 'NoDate', amount: 100, nextDate: null }];
  const r = computeCashflowLookahead({ streams, accounts: [cashAccount(500)], asOf: ASOF });
  assert.equal(r.upcoming.length, 0);
});
