const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyAccount, assetAllocation, topConcentration, buildAllocationInsights } = require('../src/intelligence/allocation');

// A realistic account set: a large pre-IPO "Stripe" position, brokerage, 401k,
// a home, and cash. Net worth ~$1.336M.
const accounts = [
  { name: 'Stripe', type: 'other', subtype: '', balance: 400000, isAsset: true },
  { name: 'Fidelity Brokerage', type: 'brokerage', subtype: '', balance: 251552, isAsset: true },
  { name: '401(k)', type: 'retirement', subtype: '401k', balance: 180000, isAsset: true },
  { name: 'Home', type: 'real estate', subtype: '', balance: 650000, isAsset: true },
  { name: 'Chase Checking', type: 'depository', subtype: 'checking', balance: 45000, isAsset: true },
  { name: 'Mortgage', type: 'loan', subtype: 'mortgage', balance: -190178, isAsset: false },
];
const accountsData = { netWorth: 1336374, totalAssets: 1526552, totalLiabilities: 190178, accounts };

test('classifyAccount maps types to broad classes', () => {
  assert.equal(classifyAccount({ name: 'Home', type: 'real estate' }), 'real_estate');
  assert.equal(classifyAccount({ name: '401(k)', type: 'retirement' }), 'retirement');
  assert.equal(classifyAccount({ name: 'Chase Checking', type: 'depository', subtype: 'checking' }), 'cash');
  assert.equal(classifyAccount({ name: 'Fidelity Brokerage', type: 'brokerage' }), 'investments');
  assert.equal(classifyAccount({ name: 'Stripe', type: 'other' }), 'other');
});

test('assetAllocation splits asset balances by class and sums to ~100%', () => {
  const a = assetAllocation(accounts);
  assert.ok(a);
  const totalPct = a.slices.reduce((s, x) => s + x.pct, 0);
  assert.ok(Math.abs(totalPct - 1) < 1e-9);
  // Home (real estate) is the largest single asset class here.
  assert.equal(a.slices[0].cls, 'real_estate');
});

test('topConcentration surfaces the Stripe position, excluding home and cash', () => {
  const c = topConcentration(accounts, 1336374);
  assert.ok(c);
  assert.equal(c.name, 'Stripe');           // not the bigger Home (real estate excluded)
  assert.ok(Math.abs(c.pct - 400000 / 1336374) < 1e-9);
  assert.equal(c.cls, 'other');
});

test('buildAllocationInsights emits an allocation card and flags Stripe concentration', () => {
  const out = buildAllocationInsights(accountsData);
  const alloc = out.find((i) => i.type === 'allocation');
  const conc = out.find((i) => i.type === 'concentration');
  assert.ok(alloc, 'expected an allocation insight');
  assert.match(alloc.title, /Asset mix:/);
  assert.ok(conc, 'expected a concentration insight');
  assert.match(conc.title, /Stripe is 30% of net worth/);
  assert.match(conc.detail, /illiquid|private|pre-IPO/i);  // 'other' class → illiquid framing
  assert.equal(conc.tone, 'watch');
});

test('buildAllocationInsights stays quiet when nothing is concentrated', () => {
  const diversified = {
    netWorth: 1000000,
    accounts: [
      { name: 'Brokerage A', type: 'brokerage', balance: 120000, isAsset: true },
      { name: 'Brokerage B', type: 'brokerage', balance: 110000, isAsset: true },
      { name: 'Cash', type: 'depository', balance: 100000, isAsset: true },
    ],
  };
  const out = buildAllocationInsights(diversified);
  assert.ok(!out.find((i) => i.type === 'concentration'), 'no single position >15% → no concentration flag');
});
